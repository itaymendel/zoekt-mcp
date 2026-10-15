import { afterEach, describe, expect, test } from "bun:test";
import { SERVER_INSTRUCTIONS } from "../src/instructions.js";
import { connectTestClient, type TestMcp } from "./helpers/mcp.js";
import { testDeps } from "./helpers/test-deps.js";

describe("instructions", () => {
	let mcp: TestMcp | undefined;
	afterEach(async () => {
		await mcp?.close();
		mcp = undefined;
	});

	test("are delivered to the client", async () => {
		mcp = await connectTestClient(testDeps());

		expect(mcp.client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
	});
});
