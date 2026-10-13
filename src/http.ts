import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import pkg from "../package.json";
import type { Logger } from "./logger.js";
import { getErrorMessage } from "./utils.js";

export interface HttpServerOptions {
	/** Called once per SSE session; an McpServer can only be connected to one transport. */
	createServer: () => McpServer;
	host: string;
	port: number;
	logger: Logger;
}

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

const SESSION_TTL_MS = 5 * 60 * 1000;

interface SSESession {
	res: ServerResponse;
	closed: boolean;
}

interface SessionEntry {
	server: McpServer;
	transport: NodeSSETransport;
	session: SSESession;
	lastActivity: number;
}

class NodeSSETransport implements Transport {
	private session: SSESession | null = null;

	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;

	setSession(session: SSESession): void {
		this.session = session;
	}

	async start(): Promise<void> {}

	async close(): Promise<void> {
		if (this.session && !this.session.closed) {
			this.session.closed = true;
			try {
				this.session.res.end();
			} catch {}
		}
		this.onclose?.();
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (!this.session || this.session.closed) {
			throw new Error("Session not connected");
		}

		const event = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
		this.session.res.write(event);
	}

	handleIncomingMessage(message: JSONRPCMessage): void {
		this.onmessage?.(message);
	}
}

export function createHttpServer({
	createServer: createMcpServer,
	host,
	port,
	logger,
}: HttpServerOptions): {
	start: () => Promise<void>;
} {
	const sessions = new Map<string, SessionEntry>();
	let httpServer: Server;

	const cleanupInterval = setInterval(() => {
		const now = Date.now();
		for (const [sessionId, entry] of sessions) {
			if (now - entry.lastActivity > SESSION_TTL_MS) {
				logger.info({ sessionId }, "Cleaning up stale session");
				entry.server.close();
				sessions.delete(sessionId);
			}
		}
	}, SESSION_TTL_MS / 2);

	function handleRequest(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const path = url.pathname;
		const method = req.method ?? "GET";

		logger.debug({ method, path }, "HTTP request");

		// Set CORS headers on all responses
		for (const [key, value] of Object.entries(CORS_HEADERS)) {
			res.setHeader(key, value);
		}

		if (method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		switch (path) {
			case "/":
				jsonResponse(res, { name: pkg.name, version: pkg.version, status: "ok" });
				break;

			case "/health":
				jsonResponse(res, { status: "ok" });
				break;

			case "/sse":
				handleSSE(req, res, createMcpServer(), sessions, logger);
				break;

			case "/messages":
				handleMessages(req, res, url, sessions, logger);
				break;

			default:
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not Found");
		}
	}

	return {
		start: async () => {
			return new Promise((resolve, reject) => {
				httpServer = createServer(handleRequest);

				httpServer.on("error", (error) => {
					logger.error({ error: getErrorMessage(error) }, "HTTP server error");
					reject(error);
				});

				httpServer.listen(port, host, () => {
					logger.info({ host, port, url: `http://${host}:${port}` }, "HTTP server started");
					resolve();
				});

				process.on("SIGINT", () => shutdown());
				process.on("SIGTERM", () => shutdown());

				function shutdown(): void {
					logger.info("Shutting down HTTP server");
					clearInterval(cleanupInterval);
					for (const entry of sessions.values()) {
						entry.server.close();
					}
					httpServer.close();
				}
			});
		},
	};
}

function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

function handleSSE(
	req: IncomingMessage,
	res: ServerResponse,
	server: McpServer,
	sessions: Map<string, SessionEntry>,
	logger: Logger,
): void {
	const sessionId = crypto.randomUUID();
	const transport = new NodeSSETransport();

	logger.info({ sessionId }, "SSE connection established");

	// Set SSE headers
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		...CORS_HEADERS,
	});

	const session: SSESession = { res, closed: false };
	transport.setSession(session);
	sessions.set(sessionId, { server, transport, session, lastActivity: Date.now() });

	// Send endpoint event
	const endpoint = `/messages?sessionId=${sessionId}`;
	res.write(`event: endpoint\ndata: ${JSON.stringify({ sessionId, messagesUrl: endpoint })}\n\n`);

	// Connect MCP server to transport
	server.connect(transport).catch((error) => {
		logger.error({ sessionId, error: getErrorMessage(error) }, "Failed to connect transport");
	});

	// Handle client disconnect
	req.on("close", () => {
		logger.info({ sessionId }, "SSE connection closed");
		session.closed = true;
		sessions.delete(sessionId);
		server.close();
	});
}

function handleMessages(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	sessions: Map<string, SessionEntry>,
	logger: Logger,
): void {
	if (req.method !== "POST") {
		res.writeHead(405, { "Content-Type": "text/plain" });
		res.end("Method not allowed");
		return;
	}

	const sessionId = url.searchParams.get("sessionId");

	if (!sessionId) {
		jsonResponse(res, { error: "Missing sessionId parameter" }, 400);
		return;
	}

	const entry = sessions.get(sessionId);
	if (!entry) {
		jsonResponse(res, { error: "Session not found" }, 404);
		return;
	}

	entry.lastActivity = Date.now();

	// Collect request body
	let body = "";
	req.on("data", (chunk) => {
		body += chunk.toString();
	});

	req.on("end", () => {
		try {
			const jsonMessage = JSON.parse(body) as JSONRPCMessage;
			logger.debug(
				{ sessionId, method: "method" in jsonMessage ? jsonMessage.method : undefined },
				"Received MCP message",
			);

			entry.transport.handleIncomingMessage(jsonMessage);
			jsonResponse(res, { status: "ok" });
		} catch (error) {
			const errorMsg = getErrorMessage(error);
			logger.error({ sessionId, error: errorMsg }, "Failed to handle message");
			jsonResponse(res, { error: errorMsg }, 500);
		}
	});

	req.on("error", (error) => {
		const errorMsg = getErrorMessage(error);
		logger.error({ sessionId, error: errorMsg }, "Request error");
		jsonResponse(res, { error: errorMsg }, 500);
	});
}
