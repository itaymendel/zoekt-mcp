import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { createMcpServer } from "../src/server.js";
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

describe("tool schemas", () => {
	test("search exposes constraints, defaults and descriptions", async () => {
		const { tools } = await client.listTools();
		const search = tools.find((t) => t.name === "search");
		const props = search?.inputSchema.properties as Record<string, Record<string, unknown>>;

		expect(props.query?.type).toBe("string");
		expect(props.query?.minLength).toBe(1);
		expect(props.limit).toBeUndefined();
		expect(props.maxFiles).toMatchObject({ minimum: 1, maximum: 100, default: 20 });
		expect(String(props.maxFiles?.description).length).toBeGreaterThan(0);
		expect(props.maxMatchesPerFile).toMatchObject({ minimum: 1, maximum: 50, default: 5 });
		expect(props.contextLines).toMatchObject({ minimum: 0, maximum: 10, default: 2 });
		expect(search?.inputSchema.required).toEqual(["query"]);
	});

	test("list_repos and read_file expose their properties", async () => {
		const { tools } = await client.listTools();
		const listRepos = tools.find((t) => t.name === "list_repos");
		const readFile = tools.find((t) => t.name === "read_file");

		expect(Object.keys(listRepos?.inputSchema.properties ?? {})).toEqual([
			"filter",
			"limit",
			"offset",
		]);
		const props = listRepos?.inputSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.filter?.maxLength).toBe(500);
		expect(props.limit).toMatchObject({ minimum: 1, maximum: 200, default: 50 });
		expect(props.offset).toMatchObject({ minimum: 0, default: 0 });
		expect(listRepos?.inputSchema.required ?? []).toEqual([]);
		expect(Object.keys(readFile?.inputSchema.properties ?? {}).sort()).toEqual([
			"branch",
			"endLine",
			"path",
			"repo",
			"startLine",
		]);
		expect(readFile?.inputSchema.required?.slice().sort()).toEqual(["path", "repo"]);
		expect(tools.some((t) => t.name === "file_content")).toBe(false);
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
			{ maxMatchesPerFile: 51 },
			{ maxMatchesPerFile: 0 },
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

	test("search ignores the removed limit argument", async () => {
		const result = await client.callTool({
			name: "search",
			arguments: { query: "foo", limit: 5 },
		});

		expect(result.isError).toBeFalsy();
		expect(new URL(requestedUrls[0] ?? "").searchParams.get("num")).toBe("21");
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

	test("read_file for a missing file says it is not found", async () => {
		const mcp = await connectTestClient(
			testDeps(mockZoektFetch({ "/print": "print-not-found", "/search": "list-all" })),
		);
		try {
			const result = await mcp.client.callTool({
				name: "read_file",
				arguments: { repo: "example.test/alpha", path: "nope.txt" },
			});

			expect(result.isError).toBe(true);
			expect(resultText(result)).toStartWith(
				"read_file error: File not found: example.test/alpha:nope.txt.",
			);
		} finally {
			await mcp.close();
		}
	});
});

describe("createMcpServer", () => {
	test("createMcpServer is a pure factory", () => {
		const shared = testDeps();
		const a = createMcpServer(shared);
		const b = createMcpServer(shared);

		expect(a).not.toBe(b);
		expect(requestedUrls).toHaveLength(0);
	});
});
