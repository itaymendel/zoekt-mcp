import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logger.js";
import { ZoektClient } from "../src/zoekt/client.js";
import { loadCase, mockZoektFetch } from "./helpers/zoekt-fixtures.js";

const mockLogger = createLogger("error");

function createClient(baseUrl = "http://localhost:6070") {
	const fetch = mockZoektFetch({
		"/search": "search-multi-fragment",
		"/print": "print-ok",
	});
	const client = new ZoektClient({ baseUrl, timeoutMs: 5000, logger: mockLogger, fetch });
	return { client, fetch };
}

describe("ZoektClient", () => {
	test("should search with query", async () => {
		const { client, fetch } = createClient();
		const result = await client.search({ query: "handleRequest" });

		expect(result.result.FileMatches?.length).toBe(2);
		expect(result.result.FileMatches?.map((m) => m.Repo).sort()).toEqual([
			"example.test/alpha",
			"example.test/beta",
		]);
		expect(fetch.requests[0].searchParams.get("q")).toBe("handleRequest");
		expect(fetch.requests[0].searchParams.get("format")).toBe("json");
	});

	test("should search with options", async () => {
		const { client, fetch } = createClient();
		const result = await client.search({
			query: "handleRequest",
			num: 10,
			contextLines: 5,
		});

		expect(result.result.FileMatches).toBeDefined();
		expect(fetch.requests[0].searchParams.get("num")).toBe("10");
		expect(fetch.requests[0].searchParams.get("ctx")).toBe("5");
	});

	test("should get file content", async () => {
		const { client, fetch } = createClient();
		const content = await client.getFileContent("example.test/alpha", "docs/notes.txt", "main");

		expect(content).toBe(loadCase("print-ok").response.bodyText as string);
		expect(fetch.requests[0].searchParams.get("r")).toBe("example.test/alpha");
		expect(fetch.requests[0].searchParams.get("f")).toBe("docs/notes.txt");
		expect(fetch.requests[0].searchParams.get("b")).toBe("main");
		expect(fetch.requests[0].searchParams.get("format")).toBe("raw");
	});

	// Reworked in PR-4 (list_repos moves to `r:` queries and the `{repos}` envelope).
	test.todo("should list repositories");

	test("should strip trailing slash from base URL", async () => {
		const { client, fetch } = createClient("http://localhost:6070/");
		const result = await client.search({ query: "test" });

		expect(result.result.FileMatches).toBeDefined();
		expect(fetch.requests[0].href.startsWith("http://localhost:6070/search?")).toBe(true);
	});
});
