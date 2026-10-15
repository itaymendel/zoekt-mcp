import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import pkg from "../package.json";
import type { Logger } from "./logger.js";
import { getErrorMessage } from "./utils.js";

const MAX_BODY_BYTES = 1_048_576;

export interface HttpServerOptions {
	/** Called once per request; must not own long-lived state (build shared deps outside). */
	createServer: () => McpServer;
	host: string;
	port: number;
	logger: Logger;
	/** When set, /mcp requires `Authorization: Bearer <token>`. */
	authToken?: string;
}

/**
 * Stateless Streamable HTTP on `POST /mcp` plus `GET /healthz`. The Hono adapter validates
 * Host and Origin on loopback binds (DNS rebinding) and bounds JSON bodies; any other bind
 * is protected by the bearer token (config refuses to start without one).
 */
export async function startHttpServer({
	createServer,
	host,
	port,
	logger,
	authToken,
}: HttpServerOptions): Promise<{ port: number; close(): Promise<void> }> {
	const onerror = (error: Error) => logger.error({ error: getErrorMessage(error) }, "MCP error");
	const handler = createMcpHandler(createServer, { onerror, maxRequestBodySize: MAX_BODY_BYTES });

	const app = createMcpHonoApp({ host, maxRequestBodySize: MAX_BODY_BYTES });
	app.get("/healthz", (c) => c.json({ status: "ok", name: pkg.name, version: pkg.version }));
	if (authToken !== undefined) app.use("/mcp", bearerAuth({ token: authToken }));
	app.all("/mcp", (c) => handler.fetch(c.req.raw));
	app.onError((error, c) => {
		if (error instanceof HTTPException) return error.getResponse();
		logger.error({ error: getErrorMessage(error) }, "HTTP request failed");
		return c.json({ error: "Internal Server Error" }, 500);
	});

	const server = await new Promise<Server>((resolve, reject) => {
		// No TLS or HTTP/2 options are passed, so this is a plain node:http server.
		const started = serve({ fetch: app.fetch, port, hostname: host }, () =>
			resolve(started),
		) as Server;
		started.once("error", reject);
	});
	server.on("error", (error) =>
		logger.error({ error: getErrorMessage(error) }, "HTTP server error"),
	);

	const bound = (server.address() as { port: number }).port;
	logger.info({ host, port: bound }, "HTTP server listening (POST /mcp)");
	return {
		port: bound,
		close: async () => {
			await handler.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
