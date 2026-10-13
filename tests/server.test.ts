import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpServer } from "../src/server.js";
import { testDeps } from "./helpers/test-deps.js";

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

	const server = createMcpServer(testDeps());
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
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
		expect(props.limit?.maximum).toBe(100);
		expect(props.limit?.minimum).toBe(1);
		expect(props.limit?.default).toBe(30);
		expect(String(props.limit?.description).length).toBeGreaterThan(0);
		expect(props.contextLines?.maximum).toBe(10);
		expect(props.contextLines?.default).toBe(3);
		expect(search?.inputSchema.required).toEqual(["query"]);
	});

	test("list_repos and file_content expose their properties", async () => {
		const { tools } = await client.listTools();
		const listRepos = tools.find((t) => t.name === "list_repos");
		const fileContent = tools.find((t) => t.name === "file_content");

		expect(Object.keys(listRepos?.inputSchema.properties ?? {})).toEqual(["filter"]);
		expect(Object.keys(fileContent?.inputSchema.properties ?? {}).sort()).toEqual([
			"branch",
			"filePath",
			"repository",
		]);
		expect(fileContent?.inputSchema.required?.slice().sort()).toEqual(["filePath", "repository"]);
	});
});

describe("tool calls", () => {
	test("search applies defaults for omitted arguments", async () => {
		const result = await client.callTool({ name: "search", arguments: { query: "foo" } });

		expect(result.isError).toBeFalsy();
		const url = new URL(requestedUrls[0] ?? "");
		expect(url.searchParams.get("q")).toBe("foo");
		expect(url.searchParams.get("num")).toBe("30");
		expect(url.searchParams.get("ctx")).toBe("3");
	});

	test("search rejects out-of-range arguments", async () => {
		const result = await client.callTool({
			name: "search",
			arguments: { query: "foo", limit: 101 },
		});

		expect(result.isError).toBe(true);
		expect(requestedUrls).toHaveLength(0);
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
