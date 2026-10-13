import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { connectTestClient } from "./helpers/mcp.js";
import { testDeps } from "./helpers/test-deps.js";

let client: Client;

beforeEach(async () => {
	({ client } = await connectTestClient(testDeps()));
});

afterEach(async () => {
	await client.close();
});

const TITLES: Record<string, string> = {
	search: "Search code",
	list_repos: "List indexed repositories",
	read_file: "Read file",
};

describe("tool titles and annotations", () => {
	test("every tool is read-only, idempotent, closed-world and non-destructive", async () => {
		const { tools } = await client.listTools();

		expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TITLES).sort());
		for (const tool of tools) {
			expect(tool.annotations).toEqual({
				readOnlyHint: true,
				idempotentHint: true,
				destructiveHint: false,
				openWorldHint: false,
			});
		}
	});

	test("titles are set on the tool, not duplicated in annotations", async () => {
		const { tools } = await client.listTools();

		for (const tool of tools) {
			expect(tool.title).toBe(TITLES[tool.name]);
			expect(tool.annotations).not.toHaveProperty("title");
		}
	});

	test("the server identifies itself with a title", () => {
		expect(client.getServerVersion()).toMatchObject({
			name: "zoekt-mcp",
			title: "Zoekt Code Search",
		});
	});
});
