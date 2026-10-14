import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { connectTestClient, resultText } from "./helpers/mcp.js";
import { testDeps } from "./helpers/test-deps.js";
import { mockZoektFetch } from "./helpers/zoekt-fixtures.js";

const originalFetch = globalThis.fetch;
let requestedUrls: string[] = [];
let client: Client;

beforeEach(async () => {
	requestedUrls = [];
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
		requestedUrls.push(String(input));
		return Response.json({
			result: { FileMatches: [], Stats: { Duration: 0, FileCount: 0, MatchCount: 0 } },
		});
	}) as typeof fetch;

	({ client } = await connectTestClient(testDeps()));
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	await client.close();
});

describe("tool metadata", () => {
	test("tools advertise read-only annotations, titles and the constraints clients validate against", async () => {
		const { tools } = await client.listTools();
		const byName = new Map(tools.map((t) => [t.name, t]));
		const props = (name: string) =>
			(byName.get(name)?.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
		const required = (name: string) => byName.get(name)?.inputSchema.required ?? [];

		expect([...byName.keys()].sort()).toEqual(["list_repos", "read_file", "search"]);
		for (const tool of tools) {
			expect(tool.title).toBeTruthy();
			expect(tool.annotations).toEqual({
				readOnlyHint: true,
				idempotentHint: true,
				destructiveHint: false,
				openWorldHint: false,
			});
		}
		expect(client.getServerVersion()).toMatchObject({
			name: "zoekt-mcp",
			title: "Zoekt Code Search",
		});

		expect(required("search")).toEqual(["query"]);
		expect([...required("read_file")].sort()).toEqual(["path", "repo"]);
		expect(required("list_repos")).toEqual([]);
		expect(Object.keys(props("search"))).toEqual(["query", "maxFiles", "contextLines"]);
		expect(Object.keys(props("list_repos"))).toEqual(["filter", "limit", "offset"]);
		expect(Object.keys(props("read_file"))).toEqual([
			"repo",
			"path",
			"branch",
			"startLine",
			"endLine",
		]);
	});
});

describe("tool calls", () => {
	test("search applies defaults for omitted arguments", async () => {
		const result = await client.callTool({ name: "search", arguments: { query: "foo" } });

		expect(result.isError).toBeFalsy();
		const url = new URL(requestedUrls[0] ?? "");
		expect(url.searchParams.get("q")).toBe("foo");
		expect(url.searchParams.get("num")).toBe("21");
		expect(url.searchParams.get("ctx")).toBe("2");
	});

	test("search rejects out-of-range arguments without calling Zoekt", async () => {
		for (const bad of [
			{ maxFiles: 101 },
			{ maxFiles: 0 },
			{ contextLines: 11 },
			{ contextLines: -1 },
			{ query: "" },
		]) {
			const result = await client.callTool({
				name: "search",
				arguments: { query: "foo", ...bad },
			});

			expect(result.isError).toBe(true);
		}
		expect(requestedUrls).toHaveLength(0);
	});
});

describe("tool errors carry Zoekt's text", () => {
	test("search with a query Zoekt rejects -> isError and the parse error", async () => {
		const mcp = await connectTestClient(
			testDeps(mockZoektFetch({ "/search": "search-error-parse" })),
		);
		try {
			const result = await mcp.client.callTool({ name: "search", arguments: { query: "(" } });

			expect(result.isError).toBe(true);
			expect(resultText(result)).toBe(
				"search error: Zoekt rejected the request: query: missing close paren, got token <nil>",
			);
		} finally {
			await mcp.close();
		}
	});
});
