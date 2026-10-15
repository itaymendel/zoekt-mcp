import { describe, expect, test } from "bun:test";
import { exactRepoAtom, repoListQuery } from "../src/zoekt/query.js";
import { ApiResponseSchema } from "../src/zoekt/types.js";
import { ALPHA_REPO } from "./helpers/fixture-repo.js";
import { hangingFetch } from "./helpers/hanging-fetch.js";
import { testDeps } from "./helpers/test-deps.js";

type Fetch = typeof globalThis.fetch;

/** A client over a canned response. */
function clientFor(
	body: string,
	{ contentType = "text/plain", ...init }: ResponseInit & { contentType?: string } = {},
	baseUrl = "http://zoekt.test",
) {
	const fetch = (async () =>
		new Response(body, { ...init, headers: { "Content-Type": contentType } })) as unknown as Fetch;
	return testDeps(fetch, { baseUrl }).client;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected promise to reject");
}

describe("credentials in the base URL", () => {
	// Node's fetch throws (echoing the password) for URLs with userinfo, so the client must move
	// it to a header. Bun tolerates userinfo, so this checks the mechanism, not the Node throw.
	test("userinfo becomes a percent-decoded Basic header on /search and /print, not part of the URL", async () => {
		const seen: Array<{ url: string; authorization: string | null }> = [];
		const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({
				url: String(input),
				authorization: new Headers(init?.headers).get("authorization"),
			});
			return Response.json({ result: { FileMatches: [] } });
		}) as unknown as Fetch;
		const { client } = testDeps(fetch, { baseUrl: "http://us%40er:p%40ss@zoekt.test:6070/" });

		await client.search({ query: "x" });
		await client.print(ALPHA_REPO, "x");

		const expected = `Basic ${Buffer.from("us@er:p@ss").toString("base64")}`;
		for (const { url, authorization } of seen) {
			expect(url).toStartWith("http://zoekt.test:6070/");
			expect(url).not.toContain("@");
			expect(authorization).toBe(expected);
		}
	});

	test("no Authorization header is sent without credentials", async () => {
		let authorization: string | null = "unset";
		const fetch = (async (_input: unknown, init?: RequestInit) => {
			authorization = new Headers(init?.headers).get("authorization");
			return Response.json({ result: { FileMatches: [] } });
		}) as unknown as Fetch;
		await testDeps(fetch).client.search({ query: "x" });

		expect(authorization).toBeNull();
	});
});

describe("failures", () => {
	test("a 5xx surfaces status and body; an HTML body is summarized, not dumped", async () => {
		const plain = clientFor("boom", { status: 502, statusText: "Bad Gateway" });
		expect((await rejection(plain.search({ query: "x" }))).message).toBe(
			"Zoekt /search failed: HTTP 502 Bad Gateway: boom",
		);

		const html = clientFor("<html>nginx</html>", {
			status: 502,
			statusText: "Bad Gateway",
			contentType: "text/html",
		});
		expect((await rejection(html.search({ query: "x" }))).message).toBe(
			"Zoekt /search failed: HTTP 502 Bad Gateway: <HTML page; is ZOEKT_URL pointing at zoekt-webserver?>",
		);
	});

	test("a 200 that is not Zoekt JSON is a protocol error (login pages, proxies, wrong shape)", async () => {
		for (const [body, contentType, expected] of [
			["oops", "text/plain", "returned a non-JSON response"],
			["<html>sso</html>", "text/html", "returned an HTML page"],
			["{}", "application/json", "neither 'result' nor 'repos'"],
		] as const) {
			const client = clientFor(body, { contentType });
			expect((await rejection(client.search({ query: "x" }))).message).toContain(expected);
		}
		const html = clientFor("<html>sso</html>", { contentType: "text/html" });
		expect((await rejection(html.print(ALPHA_REPO, "x"))).message).toContain(
			"returned an HTML page",
		);
	});

	test("a large file that merely starts with NOT-INDEXED is content", async () => {
		const body = `NOT-INDEXED: ${"x".repeat(300)}`;
		const { bytes } = await clientFor(body).print(ALPHA_REPO, "x");

		expect(new TextDecoder().decode(bytes)).toBe(body);
	});

	test("a network error reports its code and redacts credentials", async () => {
		const fail = (async () => {
			throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
		}) as unknown as Fetch;
		const { client } = testDeps(fail, { baseUrl: "http://user:secret@zoekt.test:6070" });
		const error = await rejection(client.search({ query: "x" }));

		expect(error.message).toBe("Cannot reach Zoekt at http://zoekt.test:6070 (ECONNREFUSED)");
	});

	test("a caller abort cancels the request and a slow Zoekt times out", async () => {
		const { fetch } = hangingFetch();
		const controller = new AbortController();
		const pending = rejection(
			testDeps(fetch).client.search({ query: "x" }, { signal: controller.signal }),
		);
		controller.abort();
		expect((await pending).name).toBe("AbortError");

		const slow = testDeps(fetch, { timeoutMs: 30 }).client;
		expect((await rejection(slow.search({ query: "x" }))).message).toBe(
			"Zoekt request timed out after 30ms",
		);
	});
});

describe("print streaming cap", () => {
	test("print stops reading at maxBytes instead of buffering the whole body", async () => {
		const state = { pulled: 0, cancelled: false };
		const chunk = new Uint8Array(512).fill(97);
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				state.pulled++;
				controller.enqueue(chunk);
			},
			cancel() {
				state.cancelled = true;
			},
		});
		const { client } = testDeps((async () => new Response(body)) as unknown as Fetch);

		const { bytes, truncated } = await client.print(ALPHA_REPO, "inf.txt", undefined, 1024);

		expect(bytes.length).toBe(1024);
		expect(truncated).toBe(true);
		expect(state.cancelled).toBe(true);
		expect(state.pulled).toBeLessThan(10);
	});

	test("an oversized search response is refused, not parsed", async () => {
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
			},
		});
		const { client } = testDeps((async () => new Response(body)) as unknown as Fetch);

		expect((await rejection(client.search({ query: "x" }))).message).toContain("exceeded 32 MiB");
	});

	test("an endless error body is bounded too", async () => {
		const state = { cancelled: false };
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(4096).fill(120));
			},
			cancel() {
				state.cancelled = true;
			},
		});
		const { client } = testDeps(
			(async () => new Response(body, { status: 500 })) as unknown as Fetch,
		);

		await rejection(client.search({ query: "x" }));

		expect(state.cancelled).toBe(true);
	});
});

describe("response schema", () => {
	test("Go nulls, omitted fields and unknown keys are tolerated", () => {
		const parse = (value: unknown) => ApiResponseSchema.parse(value);
		expect(parse({ result: { FileMatches: null } }).result?.FileMatches).toEqual([]);
		expect(parse({ repos: { Repos: null, Stats: { Repos: 0 } } }).repos?.Repos).toEqual([]);

		const out = parse({
			result: {
				Mystery: 1,
				FileMatches: [
					{
						FileName: "a",
						Repo: "r",
						Extra: [],
						Matches: [
							{ LineNum: 1, Fragments: [], Before: null, After: null },
							{ Fragments: null },
						],
					},
				],
			},
		});
		const [first, second] = out.result?.FileMatches[0]?.Matches ?? [];
		expect(out.result?.Stats).toBeUndefined();
		expect([first?.Before, first?.After]).toEqual(["", ""]);
		expect(second?.Fragments).toEqual([]);
	});
});

describe("query helpers", () => {
	test("the query text is the contract with Zoekt", () => {
		expect(exactRepoAtom("github.com/o/r")).toBe('r:"^github\\\\.com/o/r$"');
		expect(repoListQuery()).toBe('r:"."');
		expect(repoListQuery("api")).toBe('r:"(?i)api"');
		expect(repoListQuery("(?-i)Api")).toBe('r:"(?-i)Api"');
		expect(repoListQuery("(?i:foo)")).toBe('r:"(?i:foo)"');
		expect(repoListQuery('a"b')).toBe('r:"(?i)a\\"b"');
	});
});
