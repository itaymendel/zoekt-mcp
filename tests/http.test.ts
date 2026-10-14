import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { Writable } from "node:stream";
import { type Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHttpServer } from "../src/http.js";
import { createLogger } from "../src/logger.js";
import { createMcpServer } from "../src/server.js";
import { hangingFetch } from "./helpers/hanging-fetch.js";
import {
	rawRequest,
	startTestServer,
	type TestServer,
	type TestServerOptions,
} from "./helpers/http-harness.js";
import { makeTestClient } from "./helpers/mcp.js";
import { testDeps } from "./helpers/test-deps.js";

const servers: TestServer[] = [];

async function start(options?: TestServerOptions): Promise<TestServer> {
	const server = await startTestServer(options);
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
	const client = makeTestClient(options);
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

		expect(tools.map((t) => t.name).sort()).toEqual(["list_repos", "read_file", "search"]);
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
});

const TOKEN = "0123456789abcdef-secret";

describe("Host validation", () => {
	test("loopback Host accepted on 0.0.0.0 bind", async () => {
		const server = await start({ host: "0.0.0.0" });
		expect(server.host).toBe("0.0.0.0");
		for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
			const res = await rawRequest(server, {
				headers: { ...MCP_HEADERS, host },
				body: initializeBody(),
			});
			expect(res.status).toBe(200);
		}
	});

	test("Host evil.example rejected on 0.0.0.0 bind without MCP_ALLOWED_HOSTS", async () => {
		const server = await start({ host: "0.0.0.0" });
		const res = await rawRequest(server, {
			headers: { ...MCP_HEADERS, host: "evil.example" },
			body: initializeBody(),
		});
		expect(res.status).toBe(403);
	});

	test("host in MCP_ALLOWED_HOSTS is accepted, ports are not pinned", async () => {
		const server = await start({ allowedHosts: ["mcp.example.com"] });
		for (const host of ["mcp.example.com", "mcp.example.com:8443"]) {
			const res = await rawRequest(server, {
				headers: { ...MCP_HEADERS, host },
				body: initializeBody(),
			});
			expect(res.status).toBe(200);
		}
	});
});

describe("Origin validation", () => {
	test("a foreign Origin is 403; none and localhost pass", async () => {
		const { baseUrl } = await start();
		const status = async (origin?: string) =>
			(await postMcp(baseUrl, initializeBody(), origin === undefined ? {} : { origin })).status;

		expect(await status("https://evil.example")).toBe(403);
		expect(await status()).toBe(200);
		expect(await status("http://localhost:5173")).toBe(200);
	});
});

describe("bearer auth", () => {
	test("missing, wrong scheme, wrong token and different-length token are 401", async () => {
		const { baseUrl } = await start({ authToken: TOKEN });
		const attempts: Record<string, string>[] = [
			{},
			{ authorization: `Basic ${TOKEN}` },
			{ authorization: `Bearer ${TOKEN}x` },
			{ authorization: `Bearer ${"y".repeat(TOKEN.length)}` },
			{ authorization: "Bearer a" },
			{ authorization: "Bearer " },
			{ authorization: TOKEN },
		];
		for (const headers of attempts) {
			const res = await postMcp(baseUrl, initializeBody(), headers);
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toBe('Bearer realm="zoekt-mcp"');
		}
	});

	test("correct token completes a tool call via requestInit headers", async () => {
		const { baseUrl } = await start({ authToken: TOKEN });
		const client = makeTestClient();
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
					requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
				}),
			);
			const result = await client.callTool({
				name: "search",
				arguments: { query: "handleRequest" },
			});
			expect(result.isError).toBeFalsy();
		} finally {
			await client.close();
		}
	});

	test("/healthz and the 410 routes bypass auth, Host and Origin checks", async () => {
		const server = await start({ authToken: TOKEN });
		const headers = { origin: "https://evil.example", host: "evil.example" };
		for (const method of ["GET", "HEAD"]) {
			const res = await rawRequest(server, { path: "/healthz", method, headers });
			expect(res.status).toBe(200);
		}
		expect((await rawRequest(server, { path: "/sse", method: "GET", headers })).status).toBe(410);
		expect((await rawRequest(server, { path: "/messages", method: "POST", headers })).status).toBe(
			410,
		);
	});

	test("the token never reaches the logs", async () => {
		const lines: string[] = [];
		const sink = new Writable({
			write(chunk, _enc, done) {
				lines.push(String(chunk));
				done();
			},
		});
		const logger = createLogger("debug", sink);
		// Even a deliberately careless log of the request headers is redacted.
		logger.info({ req: { headers: { authorization: `Bearer ${TOKEN}` } } }, "careless");

		const http = createHttpServer({
			createServer: () => createMcpServer(testDeps()),
			host: "127.0.0.1",
			port: 0,
			logger,
			authToken: TOKEN,
		});
		const { port } = await http.start();
		try {
			const base = `http://127.0.0.1:${port}`;
			await postMcp(base, initializeBody(), { authorization: `Bearer ${TOKEN}` });
			await postMcp(base, initializeBody(), { authorization: `Bearer ${TOKEN}-wrong` });
		} finally {
			await http.close();
		}

		const output = lines.join("");
		expect(output).toContain("careless");
		expect(output).toContain("[redacted]");
		expect(output).not.toContain(TOKEN);
	});
});

describe("body cap", () => {
	test("a body over 1 MiB is rejected with a 4xx", async () => {
		const { baseUrl } = await start();
		const res = await postMcp(baseUrl, JSON.stringify({ pad: "x".repeat(1_048_576 + 1024) }));
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(500);
	});
});

describe("graceful shutdown", () => {
	test("idle close() is fast and the port refuses", async () => {
		const server = await start();
		expect((await fetch(`${server.baseUrl}/healthz`)).status).toBe(200);

		const started = performance.now();
		await server.close();

		expect(performance.now() - started).toBeLessThan(500);
		await expect(fetch(`${server.baseUrl}/healthz`)).rejects.toThrow();
	});

	test("an in-flight hanging tool call cannot block close() past shutdownTimeoutMs", async () => {
		const upstream = hangingFetch();
		const deps = testDeps(upstream.fetch);
		const http = createHttpServer({
			createServer: () => createMcpServer(deps),
			host: "127.0.0.1",
			port: 0,
			logger: deps.logger,
			shutdownTimeoutMs: 300,
		});
		const { port } = await http.start();
		const client = makeTestClient();
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
			);
			const pending = client
				.callTool({ name: "search", arguments: { query: "x" } })
				.catch(() => "aborted");
			await upstream.signalSeen;

			const started = performance.now();
			await http.close();
			expect(performance.now() - started).toBeLessThan(300 + 1500);
			await pending;
		} finally {
			await client.close().catch(() => {});
		}
	});

	test("a stubborn open request makes close() force after shutdownTimeoutMs", async () => {
		const server = await start({ shutdownTimeoutMs: 200 });
		// Promises a body it never sends: a request that is neither idle nor finishing.
		const socket = connect(server.port, "127.0.0.1");
		socket.on("error", () => {});
		await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
		socket.write(
			'POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"jsonrpc"',
		);
		// Deterministic sync point: the server has parsed this request's headers and is awaiting the body.
		const arrived = await server.nextRequest();
		expect(arrived.url).toBe("/mcp");

		const started = performance.now();
		await server.close();
		socket.destroy();

		expect(performance.now() - started).toBeLessThan(200 + 1500);
	});
});
