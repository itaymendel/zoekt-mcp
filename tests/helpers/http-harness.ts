import pino from "pino";
import { createHttpServer } from "../../src/http.js";
import { createServerFactory } from "../../src/server.js";
import { ZoektClient } from "../../src/zoekt/client.js";
import { type MockZoektFetch, mockZoektFetch } from "./zoekt-fixtures.js";

export interface TestServer {
	/** e.g. http://127.0.0.1:54321 */
	baseUrl: string;
	port: number;
	zoektFetch: MockZoektFetch;
	close(): Promise<void>;
}

/** Starts the real HTTP server on 127.0.0.1:0 backed by fixture-served Zoekt responses. */
export async function startTestServer(): Promise<TestServer> {
	const logger = pino({ level: "silent" });
	const zoektFetch = mockZoektFetch({
		"/search": "search-multi-fragment",
		"/print": "print-ok",
	});
	const client = new ZoektClient({
		baseUrl: "http://zoekt.test",
		timeoutMs: 5000,
		logger,
		fetch: zoektFetch,
	});
	const http = createHttpServer({
		createServer: createServerFactory({ client, logger }),
		host: "127.0.0.1",
		port: 0,
		logger,
	});
	const { port } = await http.start();
	return { baseUrl: `http://127.0.0.1:${port}`, port, zoektFetch, close: () => http.close() };
}
