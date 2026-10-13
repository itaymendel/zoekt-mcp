import { createHttpServer } from "../../src/http.js";
import { createServerFactory } from "../../src/server.js";
import { testDeps } from "./test-deps.js";
import { type MockZoektFetch, mockZoektFetch } from "./zoekt-fixtures.js";

export interface TestServer {
	/** e.g. http://127.0.0.1:54321 */
	baseUrl: string;
	port: number;
	zoektFetch: MockZoektFetch;
	/** Idempotent. */
	close(): Promise<void>;
}

/** Starts the real HTTP server on 127.0.0.1:0 backed by fixture-served Zoekt responses. */
export async function startTestServer(): Promise<TestServer> {
	const zoektFetch = mockZoektFetch({
		"/search": "search-multi-fragment",
		"/print": "print-ok",
	});
	const deps = testDeps(zoektFetch);
	const http = createHttpServer({
		createServer: createServerFactory(deps),
		host: "127.0.0.1",
		port: 0,
		logger: deps.logger,
	});
	const { port } = await http.start();
	let closing: Promise<void> | undefined;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		port,
		zoektFetch,
		close: () => {
			closing ??= http.close();
			return closing;
		},
	};
}
