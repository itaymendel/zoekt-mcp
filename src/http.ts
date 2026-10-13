import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import {
	createMcpHandler,
	localhostAllowedHostnames,
	localhostAllowedOrigins,
	type McpServer,
} from "@modelcontextprotocol/server";
import pkg from "../package.json";
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_SHUTDOWN_TIMEOUT_MS } from "./config.js";
import type { Logger } from "./logger.js";
import { getErrorMessage } from "./utils.js";

export interface HttpServerOptions {
	/** Called once per request; must not own long-lived state (build shared deps outside). */
	createServer: () => McpServer;
	host: string;
	port: number;
	logger: Logger;
	/** After this long, close() drops connections that are still open (default 10000). */
	shutdownTimeoutMs?: number;
	/** Extra Host hostnames (port-agnostic) on top of localhost; `*` disables the Host check. */
	allowedHosts?: string[];
	/** Extra allowed browser origins, already normalized (`URL.origin`, e.g. https://app.example.com); also granted CORS. */
	allowedOrigins?: string[];
	/** When set, /mcp requires `Authorization: Bearer <token>`. */
	authToken?: string;
	/** Largest accepted /mcp request body (default 1 MiB). */
	maxBodyBytes?: number;
}

export interface HttpServer {
	/** @internal test seam: the underlying node:http server, so tests can observe its events. */
	readonly server: Server;
	/** Resolves the actually bound address (supports port 0). */
	start(): Promise<{ host: string; port: number }>;
	/** `forced` is true when connections had to be dropped after shutdownTimeoutMs. */
	close(): Promise<{ forced: boolean }>;
}

type Route = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

function sendJson(
	res: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): void {
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify(body));
}

const CORS_METHODS = "GET, POST, DELETE, OPTIONS";
const DEFAULT_CORS_HEADERS =
	"content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id";

const UNAUTHORIZED_HEADERS = { "WWW-Authenticate": 'Bearer realm="zoekt-mcp"' };

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time comparison against the token's precomputed digest (equal lengths by hashing). */
function bearerMatches(header: string | undefined, tokenDigest: Buffer): boolean {
	const match = /^Bearer (.+)$/i.exec(header ?? "");
	return match?.[1] !== undefined && timingSafeEqual(sha256(match[1]), tokenDigest);
}

function normalizeOrigin(value: string | undefined): string | undefined {
	try {
		return value ? new URL(value).origin : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Remembers open sockets so they can be destroyed on shutdown. Under Bun,
 * `server.closeAllConnections()` does not release in-flight requests, so `close()` would hang.
 */
export function trackSockets(server: Server): { destroyAll(): void } {
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	return {
		destroyAll() {
			server.closeAllConnections();
			for (const socket of sockets) socket.destroy();
		},
	};
}

export function createHttpServer({
	createServer: createMcpServer,
	host,
	port,
	logger,
	shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
	allowedHosts = [],
	allowedOrigins = [],
	authToken,
	maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
}: HttpServerOptions): HttpServer {
	const onerror = (error: Error) => logger.error({ error: getErrorMessage(error) }, "MCP error");
	// Content-Length is rejected up front (bodyGuard) before anything is read; the SDK cap
	// below is what stops chunked bodies, which carry no length.
	const handler = createMcpHandler(createMcpServer, { onerror, maxRequestBodySize: maxBodyBytes });
	const mcpHandler = toNodeHandler(handler, { onerror, maxRequestBodySize: maxBodyBytes });

	const anyHost = allowedHosts.includes("*");
	if (anyHost) logger.warn("MCP_ALLOWED_HOSTS=* disables Host header validation");
	const validateHost = hostHeaderValidation([...localhostAllowedHostnames(), ...allowedHosts]);
	const corsOrigins = new Set(allowedOrigins);
	const validateOrigin = originValidation([
		...localhostAllowedOrigins(),
		...allowedOrigins.map((origin) => new URL(origin).hostname),
	]);
	const tokenDigest = authToken === undefined ? undefined : sha256(authToken);

	// Each guard returns true to continue; on false it has already answered the request.
	type Guard = (req: IncomingMessage, res: ServerResponse) => boolean;

	const hostGuard: Guard = (req, res) => anyHost || validateHost(req, res);
	const originGuard: Guard = (req, res) => validateOrigin(req, res);

	/** Echoes explicitly allowed origins and answers their preflight; nothing else gets CORS. */
	const corsGuard: Guard = (req, res) => {
		const origin = normalizeOrigin(req.headers.origin);
		const allowed = origin !== undefined && corsOrigins.has(origin);
		if (allowed) {
			res.setHeader("Access-Control-Allow-Origin", origin);
			res.setHeader("Vary", "Origin");
		}
		if (req.method !== "OPTIONS" || req.headers.origin === undefined) return true;
		if (!allowed) {
			sendJson(res, 403, { error: "Origin not allowed" });
			return false;
		}
		res.setHeader("Access-Control-Allow-Methods", CORS_METHODS);
		res.setHeader(
			"Access-Control-Allow-Headers",
			req.headers["access-control-request-headers"] ?? DEFAULT_CORS_HEADERS,
		);
		res.writeHead(204).end();
		return false;
	};

	const authGuard: Guard = (req, res) => {
		if (tokenDigest === undefined || bearerMatches(req.headers.authorization, tokenDigest)) {
			return true;
		}
		sendJson(res, 401, { error: "Unauthorized" }, UNAUTHORIZED_HEADERS);
		return false;
	};

	const bodyGuard: Guard = (req, res) => {
		if (!(Number(req.headers["content-length"]) > maxBodyBytes)) return true;
		sendJson(res, 413, { error: `Request body exceeds ${maxBodyBytes} bytes` });
		return false;
	};

	// Order matters: Host -> Origin -> CORS/preflight -> auth -> body cap -> SDK.
	const guards = [hostGuard, originGuard, corsGuard, authGuard, bodyGuard];
	const mcp: Route = async (req, res) => {
		for (const guard of guards) if (!guard(req, res)) return;
		await mcpHandler(req, res);
	};

	const removedSse: Route = (_req, res) =>
		sendJson(res, 410, {
			error: "HTTP+SSE was removed in 1.0.0; use Streamable HTTP at POST /mcp",
		});

	// Process liveness only; never touches Zoekt.
	const healthz: Route = (req, res) =>
		req.method === "GET" || req.method === "HEAD"
			? sendJson(res, 200, { status: "ok", name: pkg.name, version: pkg.version })
			: sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: "GET, HEAD" });

	const routes = new Map<string, Route>([
		["/mcp", mcp],
		["/healthz", healthz],
		["/sse", removedSse],
		["/messages", removedSse],
	]);

	const server = createServer(async (req, res) => {
		// Never derive anything from the Host header; the base is a placeholder.
		const { pathname } = new URL(req.url ?? "/", "http://placeholder");
		logger.debug({ method: req.method, path: pathname }, "HTTP request");
		try {
			const route = routes.get(pathname);
			if (route) await route(req, res);
			else sendJson(res, 404, { error: "Not Found" });
		} catch (error) {
			logger.error({ error: getErrorMessage(error) }, "HTTP request failed");
			if (!res.headersSent) sendJson(res, 500, { error: "Internal Server Error" });
			else res.destroy();
		}
	});

	const connections = trackSockets(server);

	return {
		server,
		start: () =>
			new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					server.off("error", reject);
					// After listening, a late socket-level error must be logged, not crash the process.
					server.on("error", (error) =>
						logger.error({ error: getErrorMessage(error) }, "HTTP server error"),
					);
					const address = server.address() as AddressInfo;
					logger.info({ host, port: address.port }, "HTTP server listening (POST /mcp)");
					resolve({ host: address.address, port: address.port });
				});
			}),
		close: async () => {
			let forced = false;
			const closed = new Promise<void>((resolve) => server.close(() => resolve()));
			server.closeIdleConnections();
			const timer = setTimeout(() => {
				forced = true;
				connections.destroyAll();
			}, shutdownTimeoutMs);
			try {
				await Promise.all([handler.close(), closed]);
			} finally {
				clearTimeout(timer);
			}
			return { forced };
		},
	};
}
