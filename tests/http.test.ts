import { describe, expect, test } from "bun:test";
import { createServer as createNetServer } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHttpServer } from "../src/http.js";
import type { Logger } from "../src/logger.js";

async function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createNetServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address() as { port: number };
			srv.close(() => resolve(port));
		});
	});
}

describe("HTTP SSE session cleanup", () => {
	test("logs close once and drops the session on client disconnect", async () => {
		const messages: string[] = [];
		const record = (_obj: unknown, msg?: string) => {
			if (msg) messages.push(msg);
		};
		const logger = {
			info: record,
			debug: record,
			warn: record,
			error: record,
		} as unknown as Logger;

		const port = await getFreePort();
		const http = createHttpServer({
			createServer: () => new McpServer({ name: "test", version: "0.0.0" }),
			host: "127.0.0.1",
			port,
			logger,
		});
		await http.start();

		const base = `http://127.0.0.1:${port}`;
		const controller = new AbortController();
		const res = await fetch(`${base}/sse`, { signal: controller.signal });
		const reader = res.body?.getReader();
		const first = await reader?.read();
		const text = new TextDecoder().decode(first?.value);
		const sessionId = /"sessionId":"([^"]+)"/.exec(text)?.[1];
		expect(sessionId).toBeDefined();

		const post = () =>
			fetch(`${base}/messages?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
			});
		expect((await post()).status).toBe(200);

		controller.abort();
		await Bun.sleep(100);

		expect(messages.filter((m) => m === "SSE connection closed")).toHaveLength(1);
		expect((await post()).status).toBe(404);
		expect(messages).not.toContain("Failed to close MCP server");

		// Stop the interval and HTTP server via the shutdown handler.
		process.emit("SIGTERM");
	});
});
