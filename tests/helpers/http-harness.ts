import { createHttpServer, type HttpServerOptions } from "../../src/http.js";
import { createServerFactory } from "../../src/server.js";
import { ZoektClient } from "../../src/zoekt/client.js";
import { testDeps } from "./test-deps.js";
import { type MockZoektFetch, mockZoektFetch } from "./zoekt-fixtures.js";

export interface TestServer {
	/** e.g. http://127.0.0.1:54321 */
	baseUrl: string;
	port: number;
	/** The address the socket actually bound, e.g. 127.0.0.1. */
	host: string;
	zoektFetch: MockZoektFetch;
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
	const base = testDeps(zoektFetch);
	const deps = zoektBaseUrl
		? {
				...base,
				client: new ZoektClient({
					baseUrl: zoektBaseUrl,
					timeoutMs: zoektTimeoutMs ?? 5000,
					logger: base.logger,
				}),
			}
		: base;
	const http = createHttpServer({
		createServer: createServerFactory(deps),
		host,
		port: 0,
		logger: deps.logger,
		...httpOptions,
	});
	const { host: boundHost, port } = await http.start();
	let closing: Promise<{ forced: boolean }> | undefined;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		port,
		host: boundHost,
		zoektFetch,
		close: () => {
			closing ??= http.close();
			return closing;
		},
	};
}
