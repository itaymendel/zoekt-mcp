import { describe, expect, test } from "bun:test";
import { ALPHA_REPO, BETA_REPO } from "./helpers/fixture-repo.js";
import { testDeps } from "./helpers/test-deps.js";
import { mockZoektFetch } from "./helpers/zoekt-fixtures.js";

function createClient(baseUrl = "http://localhost:6070") {
	const fetch = mockZoektFetch({
		"/search": "search-multi-fragment",
		"/print": "print-ok",
	});
	const { client } = testDeps(fetch, { baseUrl });
	return { client, fetch };
}

describe("ZoektClient", () => {
	test("should search with query and options", async () => {
		const { client, fetch } = createClient();
		const result = await client.search({ query: "handleRequest", num: 10, contextLines: 5 });

		expect(result.result.FileMatches?.map((m) => m.Repo).sort()).toEqual([ALPHA_REPO, BETA_REPO]);
		const params = fetch.requests[0].searchParams;
		expect(params.get("q")).toBe("handleRequest");
		expect(params.get("format")).toBe("json");
		expect(params.get("num")).toBe("10");
		expect(params.get("ctx")).toBe("5");
	});

	test("should strip trailing slash from base URL", async () => {
		const { client, fetch } = createClient("http://localhost:6070/");
		const result = await client.search({ query: "test" });

		expect(result.result.FileMatches).toBeDefined();
		expect(fetch.requests[0].href.startsWith("http://localhost:6070/search?")).toBe(true);
	});
});

describe("print streaming cap", () => {
	test("print stops reading at maxBytes", async () => {
		const state = { pulled: 0, cancelled: false };
		const chunk = new Uint8Array(512).fill(97);
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				state.pulled++;
				controller.enqueue(chunk);
			},
			cancel() {
				state.cancelled = true;
			},
		});
		const { client } = testDeps((async () => new Response(body)) as unknown as typeof fetch);

		const { bytes, truncated } = await client.print(ALPHA_REPO, "inf.txt", undefined, 1024);

		expect(bytes.length).toBe(1024);
		expect(truncated).toBe(true);
		expect(state.cancelled).toBe(true);
		expect(state.pulled).toBeLessThan(10);
	});
});
