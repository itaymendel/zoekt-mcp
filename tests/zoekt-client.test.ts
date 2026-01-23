import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logger.js";
import { ZoektClient } from "../src/zoekt/client.js";

const mockLogger = createLogger("error");

function createMockFetch(): typeof fetch {
	return async function mockFetch(input: RequestInfo | URL): Promise<Response> {
		const url = input instanceof Request ? input.url : String(input);

		if (url.includes("/search")) {
			const searchResponse = await Bun.file("tests/fixtures/search-response.json").text();
			return new Response(searchResponse, { headers: { "Content-Type": "application/json" } });
		}

		if (url.includes("/print")) {
			return new Response("const x = 1;\nconst y = 2;\n", {
				headers: { "Content-Type": "text/plain" },
			});
		}

		return new Response("Not Found", { status: 404 });
	} as typeof fetch;
}

function createClient(baseUrl = "http://localhost:6070") {
	return new ZoektClient({
		baseUrl,
		timeoutMs: 5000,
		logger: mockLogger,
		fetch: createMockFetch(),
	});
}

describe("ZoektClient", () => {
	test("should search with query", async () => {
		const client = createClient();
		const result = await client.search({ query: "handleRequest" });

		expect(result.result.FileMatches).toBeDefined();
		expect(result.result.FileMatches?.length).toBe(2);
		expect(result.result.FileMatches?.[0].Repo).toBe("github.com/example/repo");
	});

	test("should search with options", async () => {
		const client = createClient();
		const result = await client.search({
			query: "handleRequest",
			num: 10,
			contextLines: 5,
		});

		expect(result.result.FileMatches).toBeDefined();
	});

	test("should get file content", async () => {
		const client = createClient();
		const content = await client.getFileContent("github.com/example/repo", "src/main.ts");

		expect(content).toBe("const x = 1;\nconst y = 2;\n");
	});

	test("should list repositories", async () => {
		const client = createClient();
		const result = await client.listRepositories();

		expect(result.result.FileMatches).toBeDefined();
	});

	test("should strip trailing slash from base URL", async () => {
		const client = createClient("http://localhost:6070/");
		const result = await client.search({ query: "test" });

		expect(result.result.FileMatches).toBeDefined();
	});
});
