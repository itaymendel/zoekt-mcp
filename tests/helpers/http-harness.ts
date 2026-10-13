import { type IncomingMessage, request as nodeRequest } from "node:http";
import { createHttpServer, type HttpServerOptions } from "../../src/http.js";
import { createServerFactory } from "../../src/server.js";
import { testDeps } from "./test-deps.js";
import { type MockZoektFetch, mockZoektFetch } from "./zoekt-fixtures.js";

export interface TestServer {
	/** e.g. http://127.0.0.1:54321 */
	baseUrl: string;
	port: number;
	/** The address the socket actually bound, e.g. 127.0.0.1. */
	host: string;
	zoektFetch: MockZoektFetch;
	/** Resolves with the next request (in arrival order) whose headers the server has parsed. */
	nextRequest(): Promise<IncomingMessage>;
	/** Idempotent; `forced` is true when connections had to be dropped after shutdownTimeoutMs. */
	close(): Promise<{ forced: boolean }>;
}

export type TestServerOptions = Partial<
	Pick<
		HttpServerOptions,
		"host" | "allowedHosts" | "allowedOrigins" | "authToken" | "maxBodyBytes" | "shutdownTimeoutMs"
	>
> & {
	/** Use a real upstream (e.g. fake-zoekt) instead of the fixture-served mock fetch. */
	zoektBaseUrl?: string;
	zoektTimeoutMs?: number;
};

/** Starts the real HTTP server on port 0 (127.0.0.1 unless `host`) backed by fixture-served Zoekt. */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
	const { zoektBaseUrl, zoektTimeoutMs, host = "127.0.0.1", ...httpOptions } = options;
	const zoektFetch = mockZoektFetch({
		"/search": "search-multi-fragment",
		"/print": "print-ok",
	});
	// A real upstream (fake-zoekt) uses the global fetch; otherwise fixtures answer in-process.
	const deps = testDeps(zoektBaseUrl ? undefined : zoektFetch, {
		baseUrl: zoektBaseUrl,
		timeoutMs: zoektTimeoutMs,
	});
	const http = createHttpServer({
		createServer: createServerFactory({
			...deps,
			authRequired: httpOptions.authToken !== undefined,
		}),
		host,
		port: 0,
		logger: deps.logger,
		...httpOptions,
	});
	const arrived: IncomingMessage[] = [];
	const waiters: Array<() => void> = [];
	let consumed = 0;
	http.server.on("request", (req) => {
		arrived.push(req);
		for (const wake of waiters.splice(0)) wake();
	});
	const { host: boundHost, port } = await http.start();
	let closing: Promise<{ forced: boolean }> | undefined;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		port,
		host: boundHost,
		zoektFetch,
		async nextRequest() {
			while (consumed >= arrived.length) {
				await new Promise<void>((resolve) => waiters.push(resolve));
			}
			return arrived[consumed++] as IncomingMessage;
		},
		close: () => {
			closing ??= http.close();
			return closing;
		},
	};
}

/** fetch cannot override Host; node:http can. Resolves status, headers and body text. */
export function rawRequest(
	server: { port: number },
	options: { path?: string; method?: string; headers?: Record<string, string>; body?: string },
) {
	return new Promise<{ status: number; text: string }>((resolve, reject) => {
		const req = nodeRequest(
			{
				host: "127.0.0.1",
				port: server.port,
				path: options.path ?? "/mcp",
				method: options.method ?? "POST",
				headers: options.headers,
				agent: false,
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					text += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
			},
		);
		req.on("error", reject);
		req.end(options.body);
	});
}
