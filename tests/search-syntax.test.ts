import { afterEach, describe, expect, test } from "bun:test";
import { connectTestClient, resultText, type TestMcp } from "./helpers/mcp.js";
import { testDeps } from "./helpers/test-deps.js";

let mcp: TestMcp | undefined;
afterEach(async () => {
	await mcp?.close();
	mcp = undefined;
});

async function call(topic?: string) {
	mcp = await connectTestClient(testDeps());
	const result = await mcp.client.callTool({
		name: "search_syntax",
		arguments: topic === undefined ? {} : { topic },
	});
	return { result, text: resultText(result) };
}

describe("search_syntax", () => {
	test("without a topic it lists the sections", async () => {
		const { text } = await call();

		expect(text).toContain("- query-components: Query Components");
		expect(text).toContain("- case-sensitivity: Case Sensitivity");
	});

	test("a topic returns just that section of the upstream guide", async () => {
		const { text } = await call("case-sensitivity");

		expect(text).toStartWith("## Case Sensitivity");
		expect(text).toContain("`case:auto`");
		expect(text).not.toContain("Query Components");
	});

	test("an unknown topic is an error that lists the valid ones", async () => {
		const { result, text } = await call("nope");

		expect(result.isError).toBe(true);
		expect(text).toContain('Unknown topic "nope"');
		expect(text).toContain("- tips: Tips");
	});
});
