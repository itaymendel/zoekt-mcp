import { afterEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startHttpServer } from "../src/http.js";
import { createMcpServer } from "../src/server.js";
import { testDeps } from "./helpers/test-deps.js";

const TOKEN = "test-token";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
	await close?.();
	close = undefined;
});

async function start(authToken?: string) {
	const deps = testDeps();
	const server = await startHttpServer({
		createServer: () => createMcpServer(deps),
		host: "127.0.0.1",
		port: 0,
		logger: deps.logger,
		authToken,
	});
	close = server.close;
	return `http://127.0.0.1:${server.port}`;
}

describe("http server", () => {
	test("/healthz answers without auth", async () => {
		const base = await start(TOKEN);
		const res = await fetch(`${base}/healthz`);

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "ok", name: "zoekt-mcp" });
	});

	test("/mcp requires the bearer token when one is configured", async () => {
		const base = await start(TOKEN);
		const init = { method: "POST", body: "{}" } as const;

		expect((await fetch(`${base}/mcp`, init)).status).toBe(401);
		const authed = { ...init, headers: { authorization: `Bearer ${TOKEN}` } };
		expect((await fetch(`${base}/mcp`, authed)).status).not.toBe(401);
	});

	test("an MCP client can list the tools over HTTP", async () => {
		const base = await start(TOKEN);
		const client = new Client({ name: "test-client", version: "0.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
				requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
			}),
		);
		try {
			const { tools } = await client.listTools();
			expect(tools.map((t) => t.name).sort()).toEqual([
				"list_repos",
				"read_file",
				"search",
				"search_syntax",
			]);
		} finally {
			await client.close();
		}
	});
});
