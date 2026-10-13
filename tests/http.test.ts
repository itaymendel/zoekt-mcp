import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { Writable } from "node:stream";
import { type Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import pino from "pino";
import { loadConfig } from "../src/config.js";
import { createHttpServer } from "../src/http.js";
import { createLogger } from "../src/logger.js";
import { createServerFactory } from "../src/server.js";
import { startFakeZoekt } from "./helpers/fake-zoekt.js";
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

const TOKEN = "0123456789abcdef-secret";

describe("bind address", () => {
	test("binds 127.0.0.1 by default", async () => {
		const server = await start();
		expect(server.host).toBe("127.0.0.1");
	});

	test("binds the ::1 host that loadConfig produces from [::1]", async () => {
		const { mcpHost } = loadConfig(
			{ mcpHost: "[::1]" },
			{ ZOEKT_URL: "http://localhost:6070", MCP_TRANSPORT: "http" },
		);
		let server: TestServer;
		try {
			server = await start({ host: mcpHost });
		} catch (error) {
			// No IPv6 loopback in this environment.
			if (["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes((error as NodeJS.ErrnoException).code ?? ""))
				return;
			throw error;
		}
		expect(server.host).toBe("::1");
		expect((await fetch(`http://[::1]:${server.port}/healthz`)).status).toBe(200);
	});
});

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

	test("* disables the Host check", async () => {
		const server = await start({ allowedHosts: ["*"] });
		const res = await rawRequest(server, {
			headers: { ...MCP_HEADERS, host: "anything.example" },
			body: initializeBody(),
		});
		expect(res.status).toBe(200);
	});
});

describe("Origin validation and CORS", () => {
	test("disallowed, null and unparsable origins are 403; none and localhost pass", async () => {
		const { baseUrl } = await start();
		const status = async (origin?: string) =>
			(await postMcp(baseUrl, initializeBody(), origin === undefined ? {} : { origin })).status;

		expect(await status("https://evil.example")).toBe(403);
		expect(await status("null")).toBe(403);
		expect(await status("not a url")).toBe(403);
		expect(await status()).toBe(200);
		expect(await status("http://localhost:5173")).toBe(200);
		expect(await status("http://127.0.0.1:5173")).toBe(200);
	});

	test("allowed origin gets a matching access-control-allow-origin and Vary", async () => {
		const { baseUrl } = await start({ allowedOrigins: ["https://app.example.com"] });
		const res = await postMcp(baseUrl, initializeBody(), { origin: "https://app.example.com" });

		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
		expect(res.headers.get("vary")).toContain("Origin");
	});

	test("localhost origins pass but get no CORS headers", async () => {
		const { baseUrl } = await start({ allowedOrigins: ["https://app.example.com"] });
		const res = await postMcp(baseUrl, initializeBody(), { origin: "http://localhost:5173" });

		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	test("preflight: 204 for an allowed origin, 403 otherwise", async () => {
		const { baseUrl } = await start({ allowedOrigins: ["https://app.example.com"] });
		const preflight = (origin: string) =>
			fetch(`${baseUrl}/mcp`, {
				method: "OPTIONS",
				headers: { origin, "access-control-request-method": "POST" },
			});

		const ok = await preflight("https://app.example.com");
		expect(ok.status).toBe(204);
		expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
		expect(ok.headers.get("access-control-allow-methods")).toContain("POST");

		expect((await preflight("https://evil.example")).status).toBe(403);
		expect((await preflight("http://localhost:5173")).status).toBe(403);
	});

	test("no route ever answers access-control-allow-origin: *", async () => {
		const { baseUrl } = await start({ allowedOrigins: ["https://app.example.com"] });
		for (const origin of ["https://app.example.com", "https://evil.example", "null"]) {
			for (const path of ["/mcp", "/healthz", "/sse", "/nope"]) {
				const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { origin } });
				expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
			}
		}
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

	test("Origin is checked before auth", async () => {
		const { baseUrl } = await start({ authToken: TOKEN });
		const res = await postMcp(baseUrl, initializeBody(), { origin: "https://evil.example" });
		expect(res.status).toBe(403);
	});

	test("the token never reaches the logs", async () => {
		const lines: string[] = [];
		const sink = new Writable({
			write(chunk, _enc, done) {
				lines.push(String(chunk));
				done();
			},
		});
		const logger = createLogger("debug", undefined, sink);
		// Even a deliberately careless log of the request headers is redacted.
		logger.info({ req: { headers: { authorization: `Bearer ${TOKEN}` } } }, "careless");

		const http = createHttpServer({
			createServer: createServerFactory(testDeps()),
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
	test("2 KiB POST with Content-Length over the cap is 413", async () => {
		const { baseUrl } = await start({ maxBodyBytes: 1024 });
		const res = await postMcp(baseUrl, JSON.stringify({ pad: "x".repeat(2048) }));
		expect(res.status).toBe(413);
	});

	test("a valid body under the cap is not 413", async () => {
		const { baseUrl } = await start({ maxBodyBytes: 1024 });
		const body = initializeBody();
		expect(body.length).toBeLessThan(1024);
		expect((await postMcp(baseUrl, body)).status).toBe(200);
	});
});

describe("graceful shutdown", () => {
	test("idle close() is fast, not forced, and the port refuses", async () => {
		const server = await start();
		expect((await fetch(`${server.baseUrl}/healthz`)).status).toBe(200);

		const started = performance.now();
		const { forced } = await server.close();

		expect(performance.now() - started).toBeLessThan(500);
		expect(forced).toBe(false);
		await expect(fetch(`${server.baseUrl}/healthz`)).rejects.toThrow();
	});

	test("an in-flight hanging tool call cannot block close() past shutdownTimeoutMs", async () => {
		const zoekt = await startFakeZoekt({ hang: true });
		const server = await start({
			zoektBaseUrl: zoekt.url,
			zoektTimeoutMs: 30_000,
			shutdownTimeoutMs: 300,
		});
		const client = makeTestClient();
		try {
			await client.connect(new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`)));
			const pending = client
				.callTool({ name: "search", arguments: { query: "x" } })
				.catch(() => "aborted");
			expect(await zoekt.nextRequest()).toBe("/search");

			const started = performance.now();
			await server.close();
			expect(performance.now() - started).toBeLessThan(300 + 1500);
			await pending;
		} finally {
			await client.close().catch(() => {});
			await zoekt.close();
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
		const { forced } = await server.close();
		socket.destroy();

		expect(forced).toBe(true);
		expect(performance.now() - started).toBeLessThan(200 + 1500);
	});
});

describe("healthz bypass", () => {
	test("GET and HEAD are 200 with a bad Origin and wrong Host", async () => {
		const server = await start();
		for (const method of ["GET", "HEAD"]) {
			const res = await rawRequest(server, {
				path: "/healthz",
				method,
				headers: { origin: "https://evil.example", host: "evil.example" },
			});
			expect(res.status).toBe(200);
		}
	});
});
