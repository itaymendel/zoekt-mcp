import { afterEach, describe, expect, test } from "bun:test";
import { SERVER_INSTRUCTIONS } from "../src/instructions.js";
import { startTestServer, type TestServer } from "./helpers/http-harness.js";
import { connectModernClient } from "./helpers/mcp.js";

describe("instructions", () => {
	const servers: TestServer[] = [];
	afterEach(async () => {
		for (const server of servers.splice(0)) await server.close();
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
