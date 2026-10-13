import { describe, expect, test } from "bun:test";
import { MAX_LINE_CHARS } from "../src/clip.js";
import { capSearch, normalizeSearch, renderSearchText } from "../src/search-format.js";
import { executeSearch, searchSchema } from "../src/tools/search.js";
import { hasSymAtom } from "../src/zoekt/query.js";
import {
	SearchResultSchema,
	type SearchSymbol,
	type SymbolIndex,
	symbolKey,
} from "../src/zoekt/types.js";
import { expectGolden } from "./helpers/golden.js";
import { hangingFetch } from "./helpers/hanging-fetch.js";
import { testDeps } from "./helpers/test-deps.js";
import { loadCase, mockZoektFetch, type ZoektRoutes } from "./helpers/zoekt-fixtures.js";

const SYM_ROUTES: ZoektRoutes = { "/search": "search-sym", "/api/search": "api-search-sym" };

async function run(
	routes: ZoektRoutes,
	input: { query?: string; contextLines?: number } = {},
	signal = new AbortController().signal,
) {
	const fetch = mockZoektFetch(routes);
	const { client } = testDeps(fetch);
	const parsed = searchSchema.parse({ query: "sym:lookup", contextLines: 0, ...input });
	const result = await executeSearch(client, parsed, { signal });
	return { fetch, client, ...result };
}

describe("hasSymAtom", () => {
	test.each([
		["sym:Foo", true],
		["SYM:foo", true],
		["foo sym:bar", true],
		["(sym:a or sym:b) lang:go", true],
		["-sym:Foo", false],
		["foo -sym:Foo", false],
		["-sym:a sym:b", true],
		['"sym:Foo"', false],
		['foo "a sym:b" bar', false],
		['"a \\" sym:b"', false],
		['"x" sym:y', true],
		["foosym:bar", false],
		["symbol", false],
		["", false],
	])("%j -> %p", (query, expected) => {
		expect(hasSymAtom(query)).toBe(expected);
	});
});

describe("symbol suffix", () => {
	test("sym: search shows kind, name and parent on match rows", async () => {
		const { text } = await run(SYM_ROUTES);

		expect(text).toContain(
			"5:func (r *Registry) LookupEntry(name string) error {  [func LookupEntry in struct registry.Registry]",
		);
		expect(text).toContain(
			"9:func LookupAll(names []string) int {  [func LookupAll in package registry]",
		);
		expect(text).toContain(
			"2:\tlookupEntry(name: string): boolean {  [method lookupEntry in class Registry]",
		);
		expect(text).toContain(
			"7:export function lookupAll(names: string[]): number {  [function lookupAll]",
		);
		expectGolden("search-sym.txt", text);
	});

	test("rows keep the documented shape", async () => {
		const { text } = await run(SYM_ROUTES);
		const rows = text.split("\n").filter((l) => /^\d+[:-]/.test(l));

		expect(rows).toHaveLength(4);
		for (const row of rows) expect(row).toMatch(/^(\d+)([:-])/);
	});

	test("sends one GET /search and one POST /api/search with matching num and no context", async () => {
		const { fetch } = await run(SYM_ROUTES);

		expect(fetch.requests.map((u) => u.pathname).sort()).toEqual(["/api/search", "/search"]);
		const search = fetch.requests.find((u) => u.pathname === "/search");
		expect(search?.searchParams.get("num")).toBe("21");
		expect(search?.searchParams.get("ctx")).toBe("0");
	});

	test("the enrichment request is a JSON POST with the same num", async () => {
		const seen: { method?: string; body?: unknown } = {};
		const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname === "/api/search") {
				seen.method = init?.method;
				seen.body = JSON.parse(String(init?.body));
				return Response.json(loadCase("api-search-sym").response.body);
			}
			return Response.json(loadCase("search-sym").response.body);
		}) as typeof globalThis.fetch;
		const parsed = searchSchema.parse({ query: "sym:lookup", contextLines: 0 });
		await executeSearch(testDeps(fetch).client, parsed, { signal: new AbortController().signal });

		expect(seen.method).toBe("POST");
		expect(seen.body).toEqual({
			Q: "sym:lookup",
			Opts: { ChunkMatches: true, NumContextLines: 0, MaxDocDisplayCount: 21 },
		});
	});

	test("/api/search always asks for zero context lines, whatever contextLines is", async () => {
		const { fetch, text } = await run(SYM_ROUTES, { contextLines: 2 });

		expect(fetch.requests.find((u) => u.pathname === "/search")?.searchParams.get("ctx")).toBe("2");
		expect(text).toContain("[func LookupEntry in struct registry.Registry]");
	});

	test("model carries symbols on match lines", async () => {
		const { data } = await run(SYM_ROUTES);
		const go = data?.files.find((f) => f.path === "src/registry.go");

		expect(go?.lines.find((l) => l.n === 5)?.symbols).toEqual([
			{ name: "LookupEntry", kind: "func", parent: "registry.Registry", parentKind: "struct" },
		]);
		const ts = data?.files.find((f) => f.path === "src/registry.ts");
		expect(ts?.lines.find((l) => l.n === 7)?.symbols).toEqual([
			{ name: "lookupAll", kind: "function" },
		]);
	});
});

describe("when no enrichment is wanted", () => {
	test("a plain query makes exactly one request", async () => {
		const { fetch, text } = await run({ "/search": "search-sym" }, { query: "lookup" });

		expect(fetch.requests.map((u) => u.pathname)).toEqual(["/search"]);
		expect(text).not.toContain("  [");
	});

	test("negated -sym: makes exactly one request", async () => {
		const { fetch } = await run({ "/search": "search-sym" }, { query: "lookup -sym:foo" });

		expect(fetch.requests.map((u) => u.pathname)).toEqual(["/search"]);
	});

	test("quoted sym: text makes exactly one request", async () => {
		const { fetch } = await run({ "/search": "search-sym" }, { query: '"sym:lookup"' });

		expect(fetch.requests.map((u) => u.pathname)).toEqual(["/search"]);
	});
});

describe("enrichment failure never fails the search", () => {
	const cases: Array<[string, () => Response]> = [
		["404", () => new Response("not found", { status: 404 })],
		["HTML 200", () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } })],
		["non-JSON 200", () => new Response("garbage", { headers: { "Content-Type": "text/plain" } })],
		["schema mismatch", () => Response.json({ Result: { Files: "nope" } })],
		["JSON without Result", () => Response.json({ foo: 1 })],
		["500", () => new Response("boom", { status: 500 })],
	];

	test.each(cases)("%s", async (_name, answer) => {
		const baseline = (await run({ "/search": "search-sym" }, { query: "-sym:zzz lookup" })).text;
		const { text, fetch } = await run({ "/search": "search-sym", "/api/search": answer });

		expect(fetch.requests).toHaveLength(2);
		expect(text).toBe(baseline);
		expect(text).toContain("LookupEntry");
		expect(text).not.toContain("  [");
	});

	test("a network error on /api/search is tolerated", async () => {
		const { text } = await run({
			"/search": "search-sym",
			"/api/search": () => {
				throw new TypeError("fetch failed");
			},
		});

		expect(text).toContain("LookupEntry");
		expect(text).not.toContain("  [");
	});

	test("unavailable /api/search is remembered per client; transient failures are not", async () => {
		const calls: string[] = [];
		let apiStatus = 503;
		const fetch = (async (input: string | URL | Request) => {
			const url = new URL(String(input));
			calls.push(url.pathname);
			if (url.pathname === "/api/search") {
				return apiStatus === 200
					? Response.json(loadCase("api-search-sym").response.body)
					: new Response("x", { status: apiStatus });
			}
			return Response.json(loadCase("search-sym").response.body);
		}) as typeof globalThis.fetch;
		const { client } = testDeps(fetch);
		const input = searchSchema.parse({ query: "sym:lookup", contextLines: 0 });
		const go = () => executeSearch(client, input, { signal: new AbortController().signal });
		const apiCalls = () => calls.filter((p) => p === "/api/search").length;

		await go();
		await go();
		expect(apiCalls()).toBe(2);

		apiStatus = 404;
		await go();
		await go();
		expect(apiCalls()).toBe(3);

		apiStatus = 200;
		expect((await go()).text).not.toContain("  [");
		expect(apiCalls()).toBe(3);
	});

	test("a failing /search still fails the tool and cancels the enrichment", async () => {
		let enrichmentSignal: AbortSignal | undefined;
		const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname === "/api/search") {
				enrichmentSignal = init?.signal ?? undefined;
				return new Promise<Response>(() => {});
			}
			return new Response("bad query", { status: 418 });
		}) as typeof globalThis.fetch;
		const input = searchSchema.parse({ query: "sym:(", contextLines: 0 });
		const pending = executeSearch(testDeps(fetch).client, input, {
			signal: new AbortController().signal,
		});

		await expect(pending).rejects.toThrow(/rejected the request/);
		expect(enrichmentSignal?.aborted).toBe(true);
	});

	test("aborting the caller's signal rejects the search", async () => {
		const hang = hangingFetch();
		const controller = new AbortController();
		const input = searchSchema.parse({ query: "sym:lookup", contextLines: 0 });
		const pending = executeSearch(testDeps(hang.fetch).client, input, {
			signal: controller.signal,
		});
		const seen = await hang.signalSeen;
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(seen.aborted).toBe(true);
	});
});

describe("suffix rendering", () => {
	type Row = { n: number; text: string; before?: string };

	const stub = (rows: Row[]) =>
		SearchResultSchema.parse({
			Stats: { FileCount: 1, MatchCount: rows.length },
			FileMatches: [
				{
					FileName: "a.go",
					Repo: "r",
					Matches: rows.map(({ n, text, before }) => ({
						LineNum: n,
						Fragments: [{ Pre: "", Match: text, Post: "\n" }],
						Before: before ?? "",
					})),
				},
			],
		});

	function render(
		rows: Row[],
		symbols: Record<number, SearchSymbol[]>,
		opts: { contextLines?: number; maxChars?: number } = {},
	) {
		const index: SymbolIndex = new Map(
			Object.entries(symbols).map(([n, s]) => [symbolKey("r", "a.go", Number(n)), s]),
		);
		const model = capSearch(
			normalizeSearch(
				{ result: stub(rows), symbols: index },
				{ query: "sym:x", contextLines: opts.contextLines ?? 0 },
			),
			{ maxChars: opts.maxChars },
		);
		return renderSearchText(model);
	}

	test("parent, no parent and no kind", () => {
		const out = render(
			[
				{ n: 1, text: "A" },
				{ n: 2, text: "B" },
				{ n: 3, text: "C" },
				{ n: 4, text: "D" },
			],
			{
				1: [{ name: "A", kind: "func", parent: "P", parentKind: "struct" }],
				2: [{ name: "B", kind: "function" }],
				3: [{ name: "C", kind: "", parent: "P" }],
				4: [{ name: "D", kind: "var", parent: "Q" }],
			},
		);

		expect(out).toContain("1:A  [func A in struct P]");
		expect(out).toContain("2:B  [function B]");
		expect(out).toContain("3:C  [C in P]");
		expect(out).toContain("4:D  [var D in Q]");
	});

	test("several symbols on one line are joined with '; '", () => {
		const out = render([{ n: 1, text: "int a, b;" }], {
			1: [
				{ name: "a", kind: "variable" },
				{ name: "b", kind: "variable", parent: "S", parentKind: "struct" },
			],
		});

		expect(out).toContain("1:int a, b;  [variable a; variable b in struct S]");
	});

	test("long lines are clipped before the suffix; the suffix is capped", () => {
		const long = `x${"y".repeat(500)}`;
		const out = render([{ n: 1, text: long }], {
			1: [{ name: "n".repeat(400), kind: "func" }],
		});
		const row = out.split("\n").find((l) => l.startsWith("1:")) ?? "";
		const [code, suffix] = row.slice(2).split("  [");

		expect(code?.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
		expect(`[${suffix}`.length).toBeLessThanOrEqual(120);
		expect(row.endsWith("]")).toBe(true);
	});

	test("context rows stay bare", () => {
		const out = render(
			[{ n: 3, text: "def", before: "abc\n" }],
			{ 3: [{ name: "def", kind: "func" }], 2: [{ name: "abc", kind: "func" }] },
			{ contextLines: 1 },
		);

		expect(out).toContain("2-abc\n");
		expect(out).toContain("3:def  [func def]");
	});

	test("the output budget still applies to suffixed rows", () => {
		const rows = Array.from({ length: 30 }, (_, i) => ({ n: i + 1, text: `line ${i}` }));
		const symbols = Object.fromEntries(
			rows.map((r) => [
				r.n,
				[{ name: `symbol${r.n}`, kind: "func", parent: "Parent", parentKind: "struct" }],
			]),
		);
		const out = render(rows, symbols, { maxChars: 700 });

		expect(out).toContain("[output truncated]");
		expect(out.length).toBeLessThan(700 + 200);
	});
});
