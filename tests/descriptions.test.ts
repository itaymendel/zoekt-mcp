import { afterEach, describe, expect, test } from "bun:test";
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
