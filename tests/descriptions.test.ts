import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/client";
import { SERVER_INSTRUCTIONS } from "../src/instructions.js";
import { startTestServer, type TestServer } from "./helpers/http-harness.js";
import { connectModernClient, connectTestClient } from "./helpers/mcp.js";
import { testDeps } from "./helpers/test-deps.js";

describe("instructions", () => {
	const servers: TestServer[] = [];
	afterEach(async () => {
		for (const server of servers.splice(0)) await server.close();
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
		const client = await connectModernClient(server);
		try {
			expect(client.getProtocolEra()).toBe("modern");
			expect(client.getDiscoverResult()?.instructions).toBe(SERVER_INSTRUCTIONS);
		} finally {
			await client.close();
		}
	});
});

/** Parameter schemas as `tools/list` serializes them (JSON Schema with descriptions). */
type ParamSchemas = Record<string, { description?: string }>;

const props = (t: Tool) => (t.inputSchema.properties ?? {}) as ParamSchemas;

let tools: Tool[] = [];

beforeAll(async () => {
	const { client, close } = await connectTestClient(testDeps());
	tools = (await client.listTools()).tools;
	await close();
});

const tool = (name: string) => tools.find((t) => t.name === name) as Tool;
const description = (name: string) => tool(name).description ?? "";
const paramNames = (name: string) => Object.keys(props(tool(name)));
const backticked = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);

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

	test("every parameter has a non-empty description", () => {
		for (const t of tools) {
			for (const [param, schema] of Object.entries(props(t))) {
				expect(schema.description?.length, `${t.name}.${param}`).toBeGreaterThan(0);
			}
		}
	});

	test("a parameter named in a description exists on that tool or belongs to a tool it mentions", () => {
		const owners = new Map<string, string[]>();
		for (const t of tools) {
			for (const p of paramNames(t.name)) owners.set(p, [...(owners.get(p) ?? []), t.name]);
		}
		for (const t of tools) {
			const text = [
				t.description ?? "",
				...Object.values(props(t)).map((p) => p.description ?? ""),
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
});
