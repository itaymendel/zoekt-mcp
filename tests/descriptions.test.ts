import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SERVER_INSTRUCTIONS } from "../src/instructions.js";
import { startTestServer, type TestServer } from "./helpers/http-harness.js";
import { connectTestClient, makeTestClient } from "./helpers/mcp.js";
import { testDeps } from "./helpers/test-deps.js";

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe("instructions", () => {
	const servers: TestServer[] = [];
	afterEach(async () => {
		for (const server of servers.splice(0)) await server.close();
	});

	test("are short and teach the list_repos -> search -> read_file workflow", () => {
		expect(words(SERVER_INSTRUCTIONS)).toBeLessThanOrEqual(120);
		for (const term of ["list_repos", "search", "read_file", "repo", "path", "startLine"]) {
			expect(SERVER_INSTRUCTIONS).toContain(term);
		}
	});

	test("are delivered in the 2025 initialize result", async () => {
		const { client, close } = await connectTestClient(testDeps());
		try {
			expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
		} finally {
			await close();
		}
	});

	test("are delivered in the 2026 server/discover result", async () => {
		const server = await startTestServer();
		servers.push(server);
		const client = makeTestClient({ versionNegotiation: { mode: { pin: "2026-07-28" } } });
		try {
			await client.connect(new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`)));
			expect(client.getProtocolEra()).toBe("modern");
			expect(client.getDiscoverResult()?.instructions).toBe(SERVER_INSTRUCTIONS);
		} finally {
			await client.close();
		}
	});
});

interface ListedTool {
	name: string;
	description?: string;
	inputSchema: { properties?: Record<string, { description?: string }> };
}

let tools: ListedTool[] = [];

beforeAll(async () => {
	const { client, close } = await connectTestClient(testDeps());
	tools = (await client.listTools()).tools as ListedTool[];
	await close();
});

const tool = (name: string) => tools.find((t) => t.name === name) as ListedTool;
const description = (name: string) => tool(name).description ?? "";
const paramNames = (name: string) => Object.keys(tool(name).inputSchema.properties ?? {});
const backticked = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);

describe("word ceilings", () => {
	test.each([
		["search", 350],
		["list_repos", 90],
		["read_file", 110],
	])("%s description has at most %d words", (name, ceiling) => {
		expect(words(description(name))).toBeLessThanOrEqual(ceiling);
	});

	test("every parameter description has at most 20 words", () => {
		for (const t of tools) {
			for (const [param, schema] of Object.entries(t.inputSchema.properties ?? {})) {
				const text = schema.description ?? "";
				expect(text.length, `${t.name}.${param} has a description`).toBeGreaterThan(0);
				expect(words(text), `${t.name}.${param}`).toBeLessThanOrEqual(20);
			}
		}
	});

	// Word-count proxy for the tools/list payload: ~1.3 tokens per word, so 690 words ~ 900 tokens.
	test("all tool and parameter descriptions together stay near 900 tokens (690 words)", () => {
		const total = tools.reduce(
			(sum, t) =>
				sum +
				words(t.description ?? "") +
				Object.values(t.inputSchema.properties ?? {}).reduce(
					(n, p) => n + words(p.description ?? ""),
					0,
				),
			0,
		);
		expect(total).toBeLessThanOrEqual(690);
	});
});

describe("parameter names", () => {
	test("tools expose exactly the final parameter names", () => {
		expect(paramNames("search")).toEqual([
			"query",
			"maxFiles",
			"maxMatchesPerFile",
			"contextLines",
		]);
		expect(paramNames("list_repos")).toEqual(["filter", "limit", "offset"]);
		expect(paramNames("read_file")).toEqual(["repo", "path", "branch", "startLine", "endLine"]);
	});

	test("a parameter named in a description exists on that tool or belongs to a tool it mentions", () => {
		const owners = new Map<string, string[]>();
		for (const t of tools) {
			for (const p of paramNames(t.name)) owners.set(p, [...(owners.get(p) ?? []), t.name]);
		}
		for (const t of tools) {
			const text = [
				t.description ?? "",
				...Object.values(t.inputSchema.properties ?? {}).map((p) => p.description ?? ""),
			].join("\n");
			for (const name of backticked(text)) {
				const tools_ = owners.get(name);
				if (!tools_ || tools_.includes(t.name)) continue;
				expect(
					tools_.some((owner) => text.includes(owner)),
					`${t.name} names \`${name}\` without mentioning ${tools_.join("/")}`,
				).toBe(true);
			}
		}
	});

	test("no stale parameter or tool names remain", () => {
		const all = tools.map((t) => t.description ?? "").join("\n");
		for (const stale of ["file_content", "filePath", "maxResults", "content:"]) {
			expect(all).not.toContain(stale);
		}
		expect(description("search")).not.toMatch(/\blimit\b/);
		expect(description("read_file")).not.toMatch(/\blimit\b/);
		expect(paramNames("search")).not.toContain("limit");
	});
});

describe("search description claims", () => {
	const text = () => description("search");

	test("example queries use no syntax Zoekt lacks", () => {
		for (const span of backticked(text())) {
			expect(span, span).not.toMatch(/(^|[\s(])l:/);
			expect(span, span).not.toMatch(/ and /);
			expect(span, span).not.toContain("type:repo");
			expect(span, span).not.toContain("case:insensitive");
		}
	});

	test("teaches symbols, file-name search, the default branch, case-insensitive repos and quoting", () => {
		for (const needle of ["sym:", "ctags", "type:file", "branch:HEAD", "(?i)", "\\\\.", '\\"']) {
			expect(text(), needle).toContain(needle);
		}
	});

	test("does not claim case-insensitive matching by default", () => {
		expect(text()).not.toMatch(/case-insensitive (by )?default|default is case-insensitive/i);
	});
});

describe("list_repos and read_file descriptions", () => {
	test("list_repos documents filter, limit, offset and the (?-i) flag", () => {
		for (const needle of ["`filter`", "`limit`", "`offset`", "(?-i)", "case-insensitive"]) {
			expect(description("list_repos")).toContain(needle);
		}
	});

	test("read_file documents its range, branch and NOT-INDEXED behavior", () => {
		for (const needle of [
			"`repo`",
			"`path`",
			"`startLine`",
			"`endLine`",
			"`branch`",
			"HEAD",
			"NOT-INDEXED",
		]) {
			expect(description("read_file")).toContain(needle);
		}
	});
});
