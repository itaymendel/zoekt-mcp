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
import type { Logger } from "./logger.js";
import { getErrorMessage } from "./utils.js";

const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface HttpServerOptions {
	/** Called once per request; must not own long-lived state (build shared deps outside). */
	createServer: () => McpServer;
	host: string;
	port: number;
	logger: Logger;
	/** After this long, close() drops connections that are still open (default 10000). */
	shutdownTimeoutMs?: number;
	/** Extra Host hostnames (port-agnostic) on top of localhost; IPv6 literals in brackets. */
	allowedHosts?: string[];
	/** When set, /mcp requires `Authorization: Bearer <token>`. */
	authToken?: string;
}

interface HttpServer {
	/** @internal test seam: the underlying node:http server, so tests can observe its events. */
	readonly server: Server;
	/** Resolves the actually bound address (supports port 0). */
	start(): Promise<{ host: string; port: number }>;
	/** Stops listening, then drops any connections still open after shutdownTimeoutMs. */
	close(): Promise<void>;
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

const UNAUTHORIZED_HEADERS = { "WWW-Authenticate": 'Bearer realm="zoekt-mcp"' };

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time comparison against the token's precomputed digest (equal lengths by hashing). */
function bearerMatches(header: string | undefined, tokenDigest: Buffer): boolean {
	const match = /^Bearer (.+)$/i.exec(header ?? "");
	return match?.[1] !== undefined && timingSafeEqual(sha256(match[1]), tokenDigest);
}

/**
 * Remembers open sockets so they can be destroyed on shutdown. Under Bun,
 * `server.closeAllConnections()` does not release in-flight requests, so `close()` would hang.
 */
function trackSockets(server: Server): { destroyAll(): void } {
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
	authToken,
}: HttpServerOptions): HttpServer {
	const onerror = (error: Error) => logger.error({ error: getErrorMessage(error) }, "MCP error");
	const handler = createMcpHandler(createMcpServer, {
		onerror,
		maxRequestBodySize: MAX_BODY_BYTES,
	});
	const mcpHandler = toNodeHandler(handler, { onerror, maxRequestBodySize: MAX_BODY_BYTES });

	const validateHost = hostHeaderValidation([...localhostAllowedHostnames(), ...allowedHosts]);
	const validateOrigin = originValidation(localhostAllowedOrigins());
	const tokenDigest = authToken === undefined ? undefined : sha256(authToken);

	// Each validator answers the request itself and returns false when it rejects.
	// Order matters: Host -> Origin -> auth -> SDK (which enforces the body cap).
	const mcp: Route = async (req, res) => {
		if (!validateHost(req, res) || !validateOrigin(req, res)) return;

		if (tokenDigest !== undefined && !bearerMatches(req.headers.authorization, tokenDigest)) {
			return sendJson(res, 401, { error: "Unauthorized" }, UNAUTHORIZED_HEADERS);
		}

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
			const closed = new Promise<void>((resolve) => server.close(() => resolve()));
			server.closeIdleConnections();
			const timer = setTimeout(() => {
				logger.warn("Shutdown grace elapsed, dropping open connections");
				connections.destroyAll();
			}, shutdownTimeoutMs);
			try {
				await Promise.all([handler.close(), closed]);
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
