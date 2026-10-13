import { afterEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import pino from "pino";
import { createHttpServer } from "../src/http.js";
import { startTestServer, type TestServer } from "./helpers/http-harness.js";

const servers: TestServer[] = [];

async function start(): Promise<TestServer> {
	const server = await startTestServer();
	servers.push(server);
	return server;
}

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
});

const MCP_HEADERS = {
	"content-type": "application/json",
	accept: "application/json, text/event-stream",
};

const postMcp = (baseUrl: string, body: string, extraHeaders: Record<string, string> = {}) =>
	fetch(`${baseUrl}/mcp`, {
		method: "POST",
		headers: { ...MCP_HEADERS, ...extraHeaders },
		body,
	});

/** Connects a v2 client, lists tools, calls search, and always closes the client. */
async function roundTrip(baseUrl: string, options?: ConstructorParameters<typeof Client>[1]) {
	const client = new Client({ name: "test-client", version: "0.0.0" }, options);
	try {
		await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
		const { tools } = await client.listTools();
		const result = await client.callTool({ name: "search", arguments: { query: "handleRequest" } });
		return { tools, result, serverName: client.getServerVersion()?.name };
	} finally {
		await client.close();
	}
}

const initializeBody = (protocolVersion = "2025-06-18") =>
	JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "0" } },
	});

describe("Streamable HTTP on /mcp", () => {
	test("lists tools and calls search with a v2 client", async () => {
		const { baseUrl, zoektFetch } = await start();
		const { tools, result } = await roundTrip(baseUrl);

		expect(tools.map((t) => t.name).sort()).toEqual(["file_content", "list_repos", "search"]);
		expect(result.isError).toBeFalsy();
		expect(zoektFetch.requests[0]?.searchParams.get("q")).toBe("handleRequest");
	});

	test("serves the 2026-07-28 era through createMcpHandler", async () => {
		const { baseUrl } = await start();
		const { tools, result, serverName } = await roundTrip(baseUrl, {
			versionNegotiation: { mode: "auto" },
		});

		expect(serverName).toBe("zoekt-mcp");
		expect(tools).toHaveLength(3);
		expect(result.isError).toBeFalsy();
	});

	test("2025 initialize POST returns serverInfo", async () => {
		const { baseUrl } = await start();
		const res = await postMcp(baseUrl, initializeBody());

		expect(res.status).toBe(200);
		expect(await res.text()).toContain('"serverInfo":{"name":"zoekt-mcp"');
	});

	test("malformed JSON on /mcp is a 4xx", async () => {
		const { baseUrl } = await start();
		const res = await postMcp(baseUrl, "{not json");

		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(500);
	});
});

describe("routes", () => {
	test("/sse and /messages return 410", async () => {
		const { baseUrl } = await start();
		for (const [method, path] of [
			["GET", "/sse"],
			["POST", "/messages?sessionId=x"],
			["POST", "/sse"],
		] as const) {
			const res = await fetch(`${baseUrl}${path}`, { method });
			expect(res.status).toBe(410);
			expect(((await res.json()) as { error: string }).error).toContain("POST /mcp");
		}
	});

	test("/health and / return 404", async () => {
		const { baseUrl } = await start();
		expect((await fetch(`${baseUrl}/health`)).status).toBe(404);
		expect((await fetch(`${baseUrl}/`)).status).toBe(404);
		expect((await fetch(`${baseUrl}/nope`)).status).toBe(404);
	});

	test("/healthz returns 200 and 405 on POST", async () => {
		const { baseUrl, zoektFetch } = await start();
		const res = await fetch(`${baseUrl}/healthz`);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "ok", name: "zoekt-mcp" });
		expect((await fetch(`${baseUrl}/healthz`, { method: "HEAD" })).status).toBe(200);

		const post = await fetch(`${baseUrl}/healthz`, { method: "POST" });
		expect(post.status).toBe(405);
		expect(post.headers.get("allow")).toBe("GET, HEAD");
		expect(zoektFetch.requests).toHaveLength(0);
	});

	test("no response has access-control-allow-origin", async () => {
		const { baseUrl } = await start();
		const headers = { origin: "http://example.com" };
		const responses = await Promise.all([
			postMcp(baseUrl, initializeBody(), headers),
			fetch(`${baseUrl}/mcp`, { method: "OPTIONS", headers }),
			fetch(`${baseUrl}/healthz`, { headers }),
			fetch(`${baseUrl}/sse`, { headers }),
			fetch(`${baseUrl}/health`, { headers }),
		]);

		for (const res of responses) {
			expect(res.headers.get("access-control-allow-origin")).toBeNull();
		}
	});
});

describe("lifecycle", () => {
	test("start() reports bound port for port 0", async () => {
		const { port, baseUrl } = await start();

		expect(port).toBeGreaterThan(0);
		expect(baseUrl).toBe(`http://127.0.0.1:${port}`);
	});

	test("close() resolves and port refuses connections", async () => {
		const server = await start();
		expect((await fetch(`${server.baseUrl}/healthz`)).status).toBe(200);

		await server.close();

		await expect(fetch(`${server.baseUrl}/healthz`)).rejects.toThrow();
	});

	test("start() rejects when the port is taken", async () => {
		const first = await start();
		const second = createHttpServer({
			createServer: () => {
				throw new Error("unused");
			},
			host: "127.0.0.1",
			port: first.port,
			logger: pino({ level: "silent" }),
		});

		await expect(second.start()).rejects.toThrow();
	});
});
