import { afterEach, describe, expect, test } from "bun:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startTestServer, type TestServer } from "./helpers/http-harness.js";
import { makeTestClient } from "./helpers/mcp.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const servers: TestServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
});

/** Connects over HTTP in the 2026 era and returns the discover result and the raw tools/list result. */
async function modernListing(authToken?: string) {
	const server = await startTestServer({ authToken });
	servers.push(server);
	const client = makeTestClient({ versionNegotiation: { mode: { pin: "2026-07-28" } } });
	const requestInit = authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : undefined;
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), { requestInit }),
		);
		const tools = (await client.listTools()) as unknown as Record<string, unknown>;
		return { discover: client.getDiscoverResult() as Record<string, unknown>, tools };
	} finally {
		await client.close();
	}
}

describe("cache hints (2026-07-28 era)", () => {
	test("are public for one hour when no token is required", async () => {
		const { discover, tools } = await modernListing();

		expect(discover).toMatchObject({ ttlMs: 3_600_000, cacheScope: "public" });
		expect(tools).toMatchObject({ ttlMs: 3_600_000, cacheScope: "public" });
	});

	test("are private when a bearer token is required", async () => {
		const { discover, tools } = await modernListing(TOKEN);

		expect(discover).toMatchObject({ ttlMs: 3_600_000, cacheScope: "private" });
		expect(tools).toMatchObject({ ttlMs: 3_600_000, cacheScope: "private" });
	});
});
