import { afterEach, describe, expect, test } from "bun:test";
import { TOOLS_CACHE_TTL_MS } from "../src/instructions.js";
import { cacheScopeFor } from "../src/server.js";
import { startTestServer, type TestServer } from "./helpers/http-harness.js";
import { connectModernClient } from "./helpers/mcp.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const servers: TestServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
});

/** Connects over HTTP in the 2026 era and returns the discover result and the raw tools/list result. */
async function modernListing(token?: string) {
	const server = await startTestServer({ authToken: token });
	servers.push(server);
	const client = await connectModernClient(server, { token });
	try {
		const tools = (await client.listTools()) as unknown as Record<string, unknown>;
		return { discover: client.getDiscoverResult() as Record<string, unknown>, tools };
	} finally {
		await client.close();
	}
}

describe("cache hints (2026-07-28 era)", () => {
	test("cacheScopeFor is private exactly when a token is set", () => {
		expect(cacheScopeFor({})).toBe("public");
		expect(cacheScopeFor({ mcpAuthToken: TOKEN })).toBe("private");
	});

	test("are public for one hour when no token is required", async () => {
		const { discover, tools } = await modernListing();
		const expected = { ttlMs: TOOLS_CACHE_TTL_MS, cacheScope: "public" };

		expect(TOOLS_CACHE_TTL_MS).toBe(3_600_000);
		expect(discover).toMatchObject(expected);
		expect(tools).toMatchObject(expected);
	});

	test("are private when a bearer token is required", async () => {
		const { discover, tools } = await modernListing(TOKEN);
		const expected = { ttlMs: TOOLS_CACHE_TTL_MS, cacheScope: "private" };

		expect(discover).toMatchObject(expected);
		expect(tools).toMatchObject(expected);
	});
});
