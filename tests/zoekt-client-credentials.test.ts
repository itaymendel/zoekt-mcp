import { describe, expect, test } from "bun:test";
import { startFakeZoekt } from "./helpers/fake-zoekt.js";
import { ALPHA_REPO } from "./helpers/fixture-repo.js";
import { hangingFetch } from "./helpers/hanging-fetch.js";
import { connectTestClient, resultText } from "./helpers/mcp.js";
import { testDeps } from "./helpers/test-deps.js";

async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected promise to reject");
}

// Node's fetch throws (echoing the password) for URLs with userinfo; the client must move it to a
// header. Bun tolerates userinfo, so these tests check the mechanism, not the Node throw.
describe("credentials in the base URL", () => {
	const capture = () => {
		const seen: Array<{ url: string; headers: Headers }> = [];
		const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(input), headers: new Headers(init?.headers) });
			return Response.json({ result: { FileMatches: [] } });
		}) as unknown as typeof globalThis.fetch;
		return { seen, fetch };
	};

	test("userinfo moves to a Basic header (percent-decoded) and out of the URL", async () => {
		const { seen, fetch } = capture();
		const { client } = testDeps(fetch, { baseUrl: "http://us%40er:p%40ss@zoekt.test:6070/" });
		await client.search({ query: "x" });

		expect(seen[0]?.url).toStartWith("http://zoekt.test:6070/search?");
		expect(seen[0]?.url).not.toContain("@");
		expect(seen[0]?.url).not.toContain("ss");
		expect(seen[0]?.headers.get("authorization")).toBe(
			`Basic ${Buffer.from("us@er:p@ss").toString("base64")}`,
		);
	});

	test("a malformed percent sequence fails clearly without echoing the value", () => {
		let error: Error | undefined;
		try {
			testDeps(undefined, { baseUrl: "http://u:s3%ZZcret@zoekt.test" });
		} catch (e) {
			error = e as Error;
		}

		expect(error?.message).toBe("ZOEKT_URL credentials are not valid percent-encoding");
	});

	test("no header is sent without credentials", async () => {
		const { seen, fetch } = capture();
		await testDeps(fetch).client.search({ query: "x" });

		expect(seen[0]?.headers.has("authorization")).toBe(false);
	});

	test("the Basic header is also sent for /print", async () => {
		const { seen, fetch } = capture();
		const { client } = testDeps(fetch, { baseUrl: "http://u:s3cret@zoekt.test" });
		await client.print(ALPHA_REPO, "x").catch(() => {});

		expect(seen[0]?.headers.get("authorization")).toBe(`Basic ${btoa("u:s3cret")}`);
	});

	test("a refused connection never mentions the password", async () => {
		const fake = await startFakeZoekt();
		const { host } = new URL(fake.url);
		await fake.close();
		const { client } = testDeps(undefined, { baseUrl: `http://u:s3cret@${host}` });
		const error = await rejection(client.search({ query: "x" }));

		expect(error.message).toBe(`Cannot reach Zoekt at ${fake.url} (ECONNREFUSED)`);
		expect(error.message).not.toContain("s3cret");
	});

	test("a timeout never mentions the password", async () => {
		const { client } = testDeps(hangingFetch().fetch, {
			baseUrl: "http://u:s3cret@zoekt.test",
			timeoutMs: 20,
		});
		const error = await rejection(client.search({ query: "x" }));

		expect(error.message).toBe("Zoekt request timed out after 20ms");
	});

	test("a tool error through MCP never contains the password", async () => {
		const refuse = (async () => {
			throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
		}) as unknown as typeof globalThis.fetch;
		const mcp = await connectTestClient(
			testDeps(refuse, { baseUrl: "http://u:s3cret@zoekt.test:6070" }),
		);
		try {
			const result = await mcp.client.callTool({ name: "search", arguments: { query: "x" } });

			expect(result.isError).toBe(true);
			expect(resultText(result)).toBe(
				"search error: Cannot reach Zoekt at http://zoekt.test:6070 (ECONNREFUSED)",
			);
			expect(resultText(result)).not.toContain("s3cret");
		} finally {
			await mcp.close();
		}
	});
});
