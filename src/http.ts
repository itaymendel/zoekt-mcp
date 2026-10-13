import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import pkg from "../package.json";
import type { Logger } from "./logger.js";
import { getErrorMessage } from "./utils.js";

export interface HttpServerOptions {
	/** Called once per request; must not own long-lived state (build shared deps outside). */
	createServer: () => McpServer;
	host: string;
	port: number;
	logger: Logger;
	/** After this long, close() drops connections that are still open (default 5000). */
	shutdownTimeoutMs?: number;
	/** Extra Host hostnames (port-agnostic) on top of localhost; `*` disables the Host check. */
	allowedHosts?: string[];
	/** Extra allowed browser origins (e.g. https://app.example.com); also granted CORS. */
	allowedOrigins?: string[];
	/** When set, /mcp requires `Authorization: Bearer <token>`. */
	authToken?: string;
	/** Largest accepted /mcp request body (default 1 MiB). */
	maxBodyBytes?: number;
}

export interface HttpServer {
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

const LOCALHOST_NAMES = ["localhost", "127.0.0.1", "[::1]"];
const CORS_METHODS = "GET, POST, DELETE, OPTIONS";
const DEFAULT_CORS_HEADERS =
	"content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id";

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time comparison; hashing first makes the lengths equal. */
function bearerMatches(header: string | undefined, token: string): boolean {
	const match = /^Bearer (.+)$/i.exec(header ?? "");
	return match?.[1] !== undefined && timingSafeEqual(sha256(match[1]), sha256(token));
}

function normalizeOrigin(value: string | undefined): string | undefined {
	try {
		return value ? new URL(value).origin : undefined;
	} catch {
		return undefined;
	}
}

export function createHttpServer({
	createServer: createMcpServer,
	host,
	port,
	logger,
	shutdownTimeoutMs = 5000,
	allowedHosts = [],
	allowedOrigins = [],
	authToken,
	maxBodyBytes = 1048576,
}: HttpServerOptions): HttpServer {
	const onerror = (error: Error) => logger.error({ error: getErrorMessage(error) }, "MCP error");
	const handler = createMcpHandler(createMcpServer, { onerror, maxRequestBodySize: maxBodyBytes });
	const mcpHandler = toNodeHandler(handler, { onerror, maxRequestBodySize: maxBodyBytes });

	const checkAnyHost = allowedHosts.includes("*");
	if (checkAnyHost) logger.warn("MCP_ALLOWED_HOSTS=* disables Host header validation");
	const validateHost = hostHeaderValidation([...LOCALHOST_NAMES, ...allowedHosts]);
	const corsOrigins = new Set(allowedOrigins.map((origin) => normalizeOrigin(origin)));
	const validateOrigin = originValidation([
		...LOCALHOST_NAMES,
		...allowedOrigins.map((origin) => new URL(origin).hostname),
	]);

	// Guard order: Host -> Origin -> (CORS preflight) -> auth -> body cap -> SDK.
	const mcp: Route = async (req, res) => {
		if (!checkAnyHost && !validateHost(req, res)) return;
		if (!validateOrigin(req, res)) return;

		const origin = normalizeOrigin(req.headers.origin);
		const corsAllowed = origin !== undefined && corsOrigins.has(origin);
		if (corsAllowed) {
			res.setHeader("Access-Control-Allow-Origin", origin);
			res.setHeader("Vary", "Origin");
		}
		if (req.method === "OPTIONS" && req.headers.origin !== undefined) {
			if (!corsAllowed) return sendJson(res, 403, { error: "Origin not allowed" });
			res.setHeader("Access-Control-Allow-Methods", CORS_METHODS);
			res.setHeader(
				"Access-Control-Allow-Headers",
				req.headers["access-control-request-headers"] ?? DEFAULT_CORS_HEADERS,
			);
			res.writeHead(204).end();
			return;
		}

		if (authToken !== undefined && !bearerMatches(req.headers.authorization, authToken)) {
			return sendJson(
				res,
				401,
				{ error: "Unauthorized" },
				{ "WWW-Authenticate": 'Bearer realm="zoekt-mcp"' },
			);
		}

		if (Number(req.headers["content-length"]) > maxBodyBytes) {
			return sendJson(res, 413, { error: `Request body exceeds ${maxBodyBytes} bytes` });
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

	// closeAllConnections() is not reliable on every runtime, so also track sockets ourselves.
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});

	// Without a persistent listener a late socket-level error would crash the process.
	server.on("error", (error) =>
		logger.error({ error: getErrorMessage(error) }, "HTTP server error"),
	);

	return {
		start: () =>
			new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					server.off("error", reject);
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
				server.closeAllConnections();
				for (const socket of sockets) socket.destroy();
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
