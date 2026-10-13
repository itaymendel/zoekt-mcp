import { describe, expect, test } from "bun:test";
import { ALPHA_REPO, BETA_REPO, DELTA_REPO } from "./helpers/fixture-repo.js";
import { testDeps } from "./helpers/test-deps.js";
import { loadCase, mockZoektFetch } from "./helpers/zoekt-fixtures.js";

function createClient(baseUrl = "http://localhost:6070") {
	const fetch = mockZoektFetch({
		"/search": "search-multi-fragment",
		"/print": "print-ok",
	});
	const { client } = testDeps(fetch, { baseUrl });
	return { client, fetch };
}

describe("ZoektClient", () => {
	test("should search with query", async () => {
		const { client, fetch } = createClient();
		const result = await client.search({ query: "handleRequest" });

		expect(result.result.FileMatches?.length).toBe(2);
		expect(result.result.FileMatches?.map((m) => m.Repo).sort()).toEqual([ALPHA_REPO, BETA_REPO]);
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
		const content = await client.getFileContent(ALPHA_REPO, "docs/notes.txt", "main");

		expect(content).toBe(loadCase("print-ok").response.bodyText as string);
		expect(fetch.requests[0].searchParams.get("r")).toBe(ALPHA_REPO);
		expect(fetch.requests[0].searchParams.get("f")).toBe("docs/notes.txt");
		expect(fetch.requests[0].searchParams.get("b")).toBe("main");
		expect(fetch.requests[0].searchParams.get("format")).toBe("raw");
	});

	test("should list repositories via a repo-only query", async () => {
		const fetch = mockZoektFetch({ "/search": "list-all" });
		const { client } = testDeps(fetch);
		const repos = await client.listRepos(loadCase("list-all").request.query.q as string, {
			num: 50,
		});

		expect(repos.Stats?.Repos).toBe(3);
		expect(repos.Repos.map((r) => r.Name)).toEqual([ALPHA_REPO, BETA_REPO, DELTA_REPO]);
		const params = fetch.requests[0]?.searchParams;
		expect(params?.get("q")).toBe(loadCase("list-all").request.query.q as string);
		expect(params?.get("num")).toBe("50");
		expect(params?.get("order")).toBe("name");
	});

	test("should strip trailing slash from base URL", async () => {
		const { client, fetch } = createClient("http://localhost:6070/");
		const result = await client.search({ query: "test" });

		expect(result.result.FileMatches).toBeDefined();
		expect(fetch.requests[0].href.startsWith("http://localhost:6070/search?")).toBe(true);
	});
});
