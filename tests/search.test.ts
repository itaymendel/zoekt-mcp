import { describe, expect, test } from "bun:test";
import { clipLine } from "../src/clip.js";
import { DEFAULT_OUTPUT_CHARS, formatSearch } from "../src/search-format.js";
import { searchTool } from "../src/tools/search.js";
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
	maxFiles?: number;
	maxChars?: number;
}

function render(response: ReturnType<typeof stub>, o: RunOptions = {}): string {
	return formatSearch(response, {
		query: o.query ?? "q",
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

		expect(rowsOf(render(crlf))).toEqual(["1:x"]);
	});

	test("keeps at most 2 context lines on each side of a match", () => {
		const response = stub({
			FileMatches: [
				zfile("r", "a", [{ ...matchAt(5), Before: "b1\nb2\nb3\n", After: "a1\na2\na3\n" }]),
			],
		});

		expect(rowsOf(render(response))).toEqual(["3-b2", "4-b3", "5:line 5", "6-a1", "7-a2"]);
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

	test("omits the branch list when it is exactly HEAD", () => {
		const text = render(multi());

		expect(text).toContain("## src/handler.go\n"); // beta, HEAD only
		expect(text).not.toContain("(branches: HEAD");
		// Fragments of one line join into a single row; indentation is preserved.
		expect(text).toContain("4:\tx := handleRequest() + handleRequest()\n");
		expect(text.match(/^4:/gm)).toHaveLength(2);
	});

	test("an empty context line renders as N-", () => {
		const response = stub({
			FileMatches: [zfile("r", "a", [{ ...matchAt(3), Before: "\n" }])],
		});

		expect(rowsOf(render(response))).toEqual(["2-", "3:line 3"]);
	});

	test("shows the branch list when it is not just HEAD, in the stored order", () => {
		const text = render(multi());

		expect(text).toContain("## src/handler.go  (branches: main, main-old, feature)");
	});

	test("no matches", () => {
		expect(render(stub({}), { query: "needle" })).toBe("No matches for `needle`.");
	});

	test("shows the branch list for every non-HEAD file, even when all files agree", () => {
		const response = stub({
			FileMatches: [
				zfile("r", "a", [matchAt(1)], ["main"]),
				zfile("r", "b", [matchAt(1)], ["main"]),
				zfile("r", "c", [matchAt(1)], ["HEAD", "dev"]),
			],
		});
		const text = render(response);

		expect(text).toContain("## a  (branches: main)\n");
		expect(text).toContain("## b  (branches: main)\n");
		expect(text).toContain("## c  (branches: HEAD, dev)\n");
	});

	test("non-adjacent groups are separated by --, adjacent rows are not", () => {
		const response = stub({
			FileMatches: [zfile("r", "a", [{ ...matchAt(10), After: "ctx\n" }, matchAt(30)])],
		});
		const rows = render(response).split("\n");

		expect(rows.slice(1, 6)).toEqual(["## a", "10:line 10", "11-ctx", "--", "30:line 30"]);
	});

	test("filename-only", () => {
		const text = render(loadSearchResponse("search-file-only"));

		expect(text).toContain(
			"# example.test/alpha\n## docs/notes.txt  [filename match]  (branches: main, main-old, feature)\n",
		);
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
			{ ...o },
		);

	const cases: Array<[string, () => string, string]> = [
		[
			"maxFiles cut",
			() => render(loadSearchResponse("search-many-files"), { maxFiles: 3 }),
			`Showing 3 of 8 files; ${FOOTER}`,
		],
		["everything shown", () => two({ FileCount: 2, MatchCount: 2 }), "2 files."],
		[
			"skipped files or shards flag the result as incomplete",
			() => two({ FileCount: 2, FilesSkipped: 1, MatchCount: 2 }),
			"2 files (incomplete: Zoekt skipped part of the index).",
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

	test("the first file is always rendered, hard-clipped, even at maxChars=50", () => {
		const text = render(manyFiles(30, 40), { maxChars: 50 });

		expect(text).toContain("## dir/file0.txt");
		expect(text).toContain("\n[output truncated]\n\n---\nShowing 1 of 30 files;");
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

		expectGolden("search-truncated-budget.txt", render(response, { maxChars: 1500 }));
	});
});

describe("searchTool", () => {
	const run = (
		routes: Parameters<typeof mockZoektFetch>[0],
		input: Record<string, unknown> = {},
	) => {
		const fetch = mockZoektFetch(routes);
		const { client } = testDeps(fetch);
		const parsed = searchTool.inputSchema.parse({ query: "q", ...input });
		const result = searchTool.execute(client, parsed, { signal: new AbortController().signal });
		return { fetch, result };
	};

	test("sends ctx=2 and num = maxFiles + 1", async () => {
		const { fetch, result } = run({ "/search": "search-context" }, { query: "needle" });
		const text = await result;

		const params = fetch.requests[0]?.searchParams;
		expect(params?.get("ctx")).toBe("2");
		expect(params?.get("num")).toBe("21");
		expect(text).toContain("2:needle one");
	});

	test("sym: query is one plain /search request", async () => {
		const { fetch, result } = run({ "/search": "search-sym" }, { query: "sym:lookup" });
		const text = await result;

		expect(fetch.requests.map((u) => u.pathname)).toEqual(["/search"]);
		expectGolden("search-sym.txt", text);
	});
});
