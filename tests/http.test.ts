import { afterEach, describe, expect, test } from "bun:test";
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

/** Polls until the condition holds, failing after a bounded timeout. */
async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await Bun.sleep(5);
	}
}

const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
});

async function startServerWithSession() {
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

	const servers: McpServer[] = [];
	const port = await getFreePort();
	const http = createHttpServer({
		createServer: () => {
			const server = new McpServer({ name: "test", version: "0.0.0" });
			servers.push(server);
			return server;
		},
		host: "127.0.0.1",
		port,
		logger,
	});
	stops.push(http.stop);
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

	return { messages, servers, controller, post };
}

describe("HTTP SSE session cleanup", () => {
	test("logs close once and drops the session on client disconnect", async () => {
		const { messages, controller, post } = await startServerWithSession();
		expect((await post()).status).toBe(200);

		controller.abort();
		await waitFor(async () => (await post()).status === 404);

		expect(messages.filter((m) => m === "SSE connection closed")).toHaveLength(1);
		expect(messages).not.toContain("Failed to close MCP server");
	});

	test("drops the session when the MCP server is closed via another path", async () => {
		const { messages, servers, controller, post } = await startServerWithSession();
		expect((await post()).status).toBe(200);

		// Closes the transport (ending the response) without going through the disconnect handler,
		// so the handler sees session.closed already set and must still remove the session.
		await servers[0]?.close();
		await waitFor(async () => (await post()).status === 404);

		expect(messages).not.toContain("Failed to close MCP server");
		controller.abort();
	});
});
