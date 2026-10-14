import { describe, expect, test } from "bun:test";
import { clipLine } from "../src/clip.js";
import { DEFAULT_OUTPUT_CHARS, formatSearch } from "../src/search-format.js";
import { executeSearch, type SearchInput, searchSchema } from "../src/tools/search.js";
import { SearchResultSchema } from "../src/zoekt/types.js";
import { expectGolden } from "./helpers/golden.js";
import { testDeps } from "./helpers/test-deps.js";
import { loadSearchResponse, mockZoektFetch } from "./helpers/zoekt-fixtures.js";

function stub(raw: unknown) {
	return { result: SearchResultSchema.parse(raw) };
}

const matchAt = (n: number, text = `line ${n}`) => ({
	LineNum: n,
	Fragments: [{ Pre: "", Match: text, Post: "\n" }],
});

const zfile = (repo: string, path: string, matches: unknown[], branches = ["HEAD"]) => ({
	Repo: repo,
	FileName: path,
	Branches: branches,
	Matches: matches,
});

interface RunOptions {
	query?: string;
	contextLines?: number;
	maxFiles?: number;
	maxChars?: number;
}

function render(response: ReturnType<typeof stub>, o: RunOptions = {}): string {
	return formatSearch(response, {
		query: o.query ?? "q",
		contextLines: o.contextLines ?? 2,
		maxFiles: o.maxFiles ?? 20,
		maxChars: o.maxChars ?? DEFAULT_OUTPUT_CHARS,
	});
}

const rowsOf = (text: string) => text.split("\n").filter((l) => /^\d+[:-]/.test(l));

const hasLoneSurrogate = (s: string) =>
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe("rows", () => {
	const multi = () => loadSearchResponse("search-multi-fragment");

	test("strips CRLF from the last fragment", () => {
		const crlf = stub({
			FileMatches: [
				zfile("r", "a", [{ LineNum: 1, Fragments: [{ Pre: "", Match: "x", Post: "\r\n" }] }]),
			],
		});

		expect(rowsOf(render(crlf, { contextLines: 0 }))).toEqual(["1:x"]);
	});

	test("contextLines=0 yields no context rows", () => {
		const text = render(loadSearchResponse("search-context"), { contextLines: 0 });

		expect(rowsOf(text)).toEqual(["2:needle one", "4:needle two", "5:needle three"]);
	});

	test("null Before/After at file start and end are handled", () => {
		const result = stub({
			FileMatches: [
				zfile("r", "a", [
					{
						LineNum: 1,
						Fragments: [{ Pre: "", Match: "a", Post: "\n" }],
						Before: null,
						After: "b\n",
					},
					{
						LineNum: 3,
						Fragments: [{ Pre: "", Match: "c", Post: "" }],
						Before: "b\n",
						After: null,
					},
				]),
			],
		});

		expect(rowsOf(render(result))).toEqual(["1:a", "2-b", "3:c"]);
	});

	test("groups by repo", () => {
		const response = stub({
			FileMatches: [
				zfile("r1", "a", [matchAt(1)]),
				zfile("r2", "b", [matchAt(1)]),
				zfile("r1", "c", [matchAt(1)]),
			],
		});
		const text = render(response);

		expect(text.match(/^# .*$/gm)).toEqual(["# r1", "# r2"]);
		expect(text.indexOf("## c")).toBeLessThan(text.indexOf("# r2"));
	});

	test("omits HEAD branch", () => {
		const text = render(multi(), { contextLines: 0 });

		expect(text).toContain("## src/handler.go\n"); // beta, HEAD only
		expect(text).not.toContain("(branches: HEAD");
	});

	test("shows the branch list when files differ, in the stored order", () => {
		const text = render(multi(), { contextLines: 0 });

		expect(text).toContain("## src/handler.go  (branches: main, main-old, feature)");
	});

	test("filename matches are not undercounted when Stats are missing", () => {
		const response = stub({
			FileMatches: [
				zfile("r", "a", [{ LineNum: 0, Fragments: [{ Pre: "", Match: "a", Post: "" }] }]),
				zfile("r", "b", [matchAt(4), matchAt(9)]),
			],
		});

		expect(render(response, { contextLines: 0 })).toMatch(
			/\n---\n2 files, 2 matching lines, 1 filename match\.$/,
		);
		expect(render(loadSearchResponse("search-file-only"))).toMatch(
			/\n---\n1 file, 1 filename match\.$/,
		);
	});

	test("no matches", () => {
		expect(render(stub({}), { query: "needle" })).toBe("No matches for `needle`.");
	});

	test("omits branch list when uniform across results", () => {
		const text = render(loadSearchResponse("search-context"));

		expect(text).not.toContain("branches");
		expect(text).toContain("## docs/notes.txt\n");
	});

	test("non-adjacent groups are separated by --, adjacent rows are not", () => {
		const response = stub({
			FileMatches: [zfile("r", "a", [{ ...matchAt(10), After: "ctx\n" }, matchAt(30)])],
		});
		const rows = render(response, { contextLines: 1 }).split("\n");

		expect(rows.slice(1, 6)).toEqual(["## a", "10:line 10", "11-ctx", "--", "30:line 30"]);
	});

	test("filename-only", () => {
		const text = render(loadSearchResponse("search-file-only"));

		expect(text).toContain("# example.test/alpha\n## docs/notes.txt  [filename match]\n");
		expect(text).not.toMatch(/^\d+[:-]/m);
	});

	test("not indexed", () => {
		const response = stub({
			FileMatches: [
				zfile("r", "bin.dat", [
					{ LineNum: 1, Fragments: [{ Pre: "", Match: "NOT-INDEXED", Post: ": binary\n" }] },
				]),
			],
		});
		const text = render(response);

		expect(text).toContain("## bin.dat  [not indexed: binary/too large]");
		expect(text).not.toContain("1:");
	});

	test("clips long lines", () => {
		const response = stub({
			FileMatches: [
				zfile("r", "a", [
					{
						LineNum: 7,
						Fragments: [{ Pre: "a".repeat(2500), Match: "NEEDLE", Post: `${"b".repeat(2494)}\n` }],
					},
				]),
			],
		});
		const row = render(response)
			.split("\n")
			.find((l) => l.startsWith("7:")) as string;

		expect(row.length).toBeLessThanOrEqual(245);
		expect(row).toContain("NEEDLE");
		expect(row).toContain("…");
	});

	test("clipping never splits a surrogate pair", () => {
		for (const [before, after] of [
			[500, 500],
			[501, 500],
			[0, 800],
			[800, 0],
		] as const) {
			const text = `${"😀".repeat(before)}NEEDLE${"😀".repeat(after)}`;
			const clipped = clipLine(text, { focus: [before * 2, before * 2 + 6] });

			expect(hasLoneSurrogate(clipped)).toBe(false);
			expect(clipped).toContain("NEEDLE");
			expect(clipped.length).toBeLessThanOrEqual(240);
		}
		expect(hasLoneSurrogate(clipLine("😀".repeat(400)))).toBe(false);
	});
});

describe("footer", () => {
	const FOOTER = "narrow with r:/f:/lang:";
	const two = (Stats?: object, o: RunOptions = {}) =>
		render(
			stub({ Stats, FileMatches: [zfile("r", "a", [matchAt(1)]), zfile("r", "b", [matchAt(1)])] }),
			{ contextLines: 0, ...o },
		);

	const cases: Array<[string, () => string, string]> = [
		[
			"maxFiles cut",
			() => render(loadSearchResponse("search-many-files"), { contextLines: 0, maxFiles: 3 }),
			`Showing 3 of 8 files; ${FOOTER}`,
		],
		[
			"missing Stats makes the total a lower bound",
			() => two(undefined, { maxFiles: 1 }),
			`Showing 1 of at least 2 files; ${FOOTER}`,
		],
		[
			"a lower bound alone is not truncation (FilesSkipped)",
			() => two({ FileCount: 2, FilesSkipped: 1, MatchCount: 2 }),
			"At least 2 files, 2 matching lines.",
		],
		[
			"a lower bound alone is not truncation (ShardsSkipped)",
			() => two({ FileCount: 2, ShardsSkipped: 2, MatchCount: 2 }),
			"At least 2 files, 2 matching lines.",
		],
	];

	test.each(cases)("%s", (_name, run, expected) => {
		expect(run().split("\n---\n")[1]).toBe(expected);
	});
});

describe("output cap", () => {
	const lines = (n: number, width = 40) =>
		Array.from({ length: n }, (_, i) => matchAt(i + 1, `${"x".repeat(width)}${i}`));
	const manyFiles = (files: number, perFile: number, width?: number) =>
		stub({
			Stats: { FileCount: files, MatchCount: files * perFile },
			FileMatches: Array.from({ length: files }, (_, i) =>
				zfile(`repo${i % 3}`, `dir/file${i}.txt`, lines(perFile, width)),
			),
		});

	test("30 files x 40 lines under maxChars=3000 stops at the cap", () => {
		const text = render(manyFiles(30, 40), { maxChars: 3000, contextLines: 0 });
		const [body, footer] = text.split("\n\n---\n");

		expect((body as string).length).toBeLessThanOrEqual(3000 + "\n[output truncated]".length);
		expect(body).toEndWith("\n[output truncated]");
		expect(footer).toMatch(/^Showing \d+ of 30 files; narrow with r:\/f:\/lang:$/);
	});

	test("the first file is always rendered, hard-clipped, even at maxChars=50", () => {
		const text = render(manyFiles(30, 40), { maxChars: 50, contextLines: 0 });

		expect(text).toContain("## dir/file0.txt");
		expect(text).toContain("\n[output truncated]\n\n---\nShowing 1 of 30 files;");
	});

	test("worst case: 100 files of long rows stays within DEFAULT_OUTPUT_CHARS plus the marker and footer", () => {
		const text = render(manyFiles(100, 50, 300), { maxFiles: 100, contextLines: 2 });

		expect(text.length).toBeLessThanOrEqual(DEFAULT_OUTPUT_CHARS + 200);
		expect(text.length).toBeGreaterThan(DEFAULT_OUTPUT_CHARS / 2);
	});

	test("truncated by the cap: golden", () => {
		const response = stub({
			Stats: { FileCount: 12, MatchCount: 60 },
			FileMatches: Array.from({ length: 12 }, (_, i) =>
				zfile(
					"example.test/alpha",
					`pkg/mod${i}.go`,
					[1, 2, 3, 4, 5].map((n) => matchAt(n * 10, `needle ${"w".repeat(30)} ${i}.${n}`)),
				),
			),
		});

		expectGolden(
			"search-truncated-budget.txt",
			render(response, { contextLines: 0, maxChars: 1500 }),
		);
	});
});

describe("executeSearch", () => {
	const run = (routes: Parameters<typeof mockZoektFetch>[0], input: Partial<SearchInput> = {}) => {
		const fetch = mockZoektFetch(routes);
		const { client } = testDeps(fetch);
		const parsed = searchSchema.parse({ query: "q", ...input });
		const result = executeSearch(client, parsed, { signal: new AbortController().signal });
		return { fetch, result };
	};

	test("sends ctx from contextLines and num = maxFiles + 1", async () => {
		const { fetch, result } = run(
			{ "/search": "search-context" },
			{ query: "needle", contextLines: 2 },
		);
		const text = await result;

		const params = fetch.requests[0]?.searchParams;
		expect(params?.get("ctx")).toBe("2");
		expect(params?.get("num")).toBe("21");
		expect(text).toContain("2:needle one");
	});

	test("sym: query is one plain /search request", async () => {
		const { fetch, result } = run(
			{ "/search": "search-sym" },
			{ query: "sym:lookup", contextLines: 0 },
		);
		const text = await result;

		expect(fetch.requests.map((u) => u.pathname)).toEqual(["/search"]);
		expectGolden("search-sym.txt", text);
	});
});
