import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
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
}

export interface HttpServer {
	/** Resolves the actually bound address (supports port 0). */
	start(): Promise<{ host: string; port: number }>;
	close(): Promise<void>;
}

type Route = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

function sendJson(res: ServerResponse, status: number, body: unknown, headers = {}): void {
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify(body));
}

export function createHttpServer({
	createServer: createMcpServer,
	host,
	port,
	logger,
	shutdownTimeoutMs = 5000,
}: HttpServerOptions): HttpServer {
	const onerror = (error: Error) => logger.error({ error: getErrorMessage(error) }, "MCP error");
	const handler = createMcpHandler(createMcpServer, { onerror });
	const mcp = toNodeHandler(handler, { onerror });

	const removedSse: Route = (_req, res) =>
		sendJson(res, 410, {
			error: "HTTP+SSE was removed in 1.0.0; use Streamable HTTP at POST /mcp",
		});

	const routes = new Map<string, Route>([
		["/mcp", (req, res) => mcp(req, res)],
		[
			"/healthz",
			(req, res) =>
				req.method === "GET" || req.method === "HEAD"
					? sendJson(res, 200, { status: "ok", name: pkg.name, version: pkg.version })
					: sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: "GET, HEAD" }),
		],
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

	return {
		start: () =>
			new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					server.off("error", reject);
					const address = server.address() as AddressInfo;
					logger.info({ host, port: address.port }, "HTTP server listening (POST /mcp)");
					resolve({ host, port: address.port });
				});
			}),
		close: async () => {
			await handler.close();
			const closed = new Promise<void>((resolve) => server.close(() => resolve()));
			server.closeIdleConnections();
			const timer = setTimeout(() => server.closeAllConnections(), shutdownTimeoutMs);
			await closed;
			clearTimeout(timer);
		},
	};
}
