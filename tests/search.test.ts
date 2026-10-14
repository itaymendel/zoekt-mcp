import { describe, expect, test } from "bun:test";
import { clipLine, MAX_LINE_CHARS } from "../src/clip.js";
import { DEFAULT_OUTPUT_CHARS, FOOTER_RESERVE, formatSearch } from "../src/search-format.js";
import { executeSearch, type SearchInput, searchSchema } from "../src/tools/search.js";
import { SearchResultSchema } from "../src/zoekt/types.js";
import { expectGolden } from "./helpers/golden.js";
import { testDeps } from "./helpers/test-deps.js";
import { loadSearchResponse, mockZoektFetch, readRepoFile } from "./helpers/zoekt-fixtures.js";

function stub(raw: unknown) {
	return { result: SearchResultSchema.parse(raw) };
}

const NOTES = readRepoFile("alpha", "docs/notes.txt").split("\n");

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
	maxMatchesPerFile?: number;
	maxFiles?: number;
	maxChars?: number;
}

function render(response: ReturnType<typeof stub>, o: RunOptions = {}): string {
	return formatSearch(response, {
		query: o.query ?? "q",
		contextLines: o.contextLines ?? 2,
		maxMatchesPerFile: o.maxMatchesPerFile ?? 5,
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

	test("a hidden match shown as context is not counted as hidden", () => {
		const result = stub({
			FileMatches: [zfile("r", "a", [{ ...matchAt(10), After: "line 11\n" }, matchAt(11)])],
		});
		const text = render(result, { contextLines: 1, maxMatchesPerFile: 1 });

		expect(rowsOf(text)).toEqual(["10:line 10", "11-line 11"]);
		expect(text).not.toContain("more matching");
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

	test("repo and path on separate lines", () => {
		const text = render(multi(), { contextLines: 0 });

		expect(text).toContain("# example.test/alpha\n## src/handler.go");
		expect(text).not.toContain("example.test/alpha/src/handler.go");
	});

	test("rows are N:text, with indentation and one row for a multi-fragment line", () => {
		const text = render(multi(), { contextLines: 0 });

		expect(text).toContain("4:\tx := handleRequest() + handleRequest()\n");
		expect(text.match(/^4:/gm)).toHaveLength(2); // one per file, not one per fragment
		expect(text).not.toMatch(/^> /m);
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

	test("context fixture renders - rows and : rows numbered like the real file", () => {
		const rows = rowsOf(render(loadSearchResponse("search-context")));

		expect(rows).toEqual([
			"1-first line",
			"2:needle one",
			"3-third line",
			"4:needle two",
			"5:needle three",
		]);
		rows.forEach((r, i) => {
			expect(r.slice(2)).toBe(NOTES[i] as string);
		});
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
			expect(clipped.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
		}
		expect(hasLoneSurrogate(clipLine("😀".repeat(400)))).toBe(false);
	});

	test("overflow row counts hidden matching lines", () => {
		const two = stub({ FileMatches: [zfile("r", "a", [matchAt(1), matchAt(2)])] });
		const three = stub({ FileMatches: [zfile("r", "a", [matchAt(1), matchAt(2), matchAt(3)])] });

		expect(render(two, { maxMatchesPerFile: 1 })).toContain("[+1 more matching line in this file]");
		expect(render(three, { maxMatchesPerFile: 1 })).toContain(
			"[+2 more matching lines in this file]",
		);
	});

	test("per-file cap [90,12,55] with K=2 shows 12 and 90 and one hidden line", () => {
		const response = stub({
			FileMatches: [zfile("r", "a", [matchAt(90), matchAt(12), matchAt(55)])],
		});
		const text = render(response, { contextLines: 0, maxMatchesPerFile: 2 });

		expect(text).toContain(
			"## a\n12:line 12\n--\n90:line 90\n[+1 more matching line in this file]",
		);
		expect(text).toContain("hidden by maxMatchesPerFile=2");
	});

	test("complete results have a plain footer", () => {
		const text = render(multi(), { contextLines: 0 });

		expect(text.endsWith("\n\n---\n2 files, 2 matching lines.")).toBe(true);
	});

	test("filename matches are counted apart from matching lines", () => {
		const response = stub({
			Stats: { FileCount: 2, MatchCount: 3 },
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
});

describe("footer", () => {
	const REFINE =
		"Refine with repo:, file:, lang: or -file: filters, or raise maxFiles / maxMatchesPerFile.";
	const one = (Stats: object, o: RunOptions = {}) =>
		render(stub({ Stats, FileMatches: [zfile("r", "a", [matchAt(1), matchAt(2), matchAt(3)])] }), {
			contextLines: 0,
			...o,
		});
	const two = (Stats: object, o: RunOptions = {}) =>
		render(
			stub({ Stats, FileMatches: [zfile("r", "a", [matchAt(1)]), zfile("r", "b", [matchAt(1)])] }),
			{ contextLines: 0, ...o },
		);
	const wide = "x".repeat(100);
	const three = () =>
		stub({
			Stats: { FileCount: 5, FilesSkipped: 1, MatchCount: 5 },
			FileMatches: ["a", "b", "c"].map((p) => zfile("r", p, [matchAt(1, wide)])),
		});

	const cases: Array<[string, () => string, string]> = [
		[
			"maxFiles cut",
			() => render(loadSearchResponse("search-many-files"), { contextLines: 0, maxFiles: 3 }),
			`Truncated: showing 3 of 8 files. ${REFINE}`,
		],
		[
			"maxFiles cut on a lower bound",
			() => two({ FileCount: 4, FilesSkipped: 12, MatchCount: 4 }, { maxFiles: 2 }),
			`Truncated: showing 2 of at least 4 files. ${REFINE}`,
		],
		[
			"the lower bound is stated once when maxFiles truncated too",
			() => two({ FileCount: 4, FilesSkipped: 1, MatchCount: 4 }, { maxFiles: 1 }),
			`Truncated: showing 1 of at least 4 files. ${REFINE}`,
		],
		[
			"maxMatchesPerFile cut on a lower bound",
			() => one({ FileCount: 1, FilesSkipped: 3, MatchCount: 3 }, { maxMatchesPerFile: 1 }),
			`Truncated: 2 more matching lines hidden by maxMatchesPerFile=1; at least 1 file matched. ${REFINE}`,
		],
		[
			"budget clause uses singular 'file' for one file",
			() =>
				render(
					stub({
						Stats: { FileCount: 1, FilesSkipped: 1, MatchCount: 1 },
						FileMatches: [zfile("r", "a", [matchAt(1, "x".repeat(300))])],
					}),
					{ maxChars: 50, contextLines: 0 },
				),
			`Truncated: output budget (50 chars) reached after 1 of at least 1 file. ${REFINE}`,
		],
		[
			"maxFiles and the budget both cut on a lower bound",
			() => render(three(), { maxFiles: 2, maxChars: 650, contextLines: 0 }),
			`Truncated: showing 1 of at least 5 files; output budget (650 chars) reached after 1 of 2 files. ${REFINE}`,
		],
		[
			"a lower bound alone is not truncation (FilesSkipped)",
			() => one({ FileCount: 1, FilesSkipped: 1, MatchCount: 3 }),
			"At least 1 file, 3 matching lines.",
		],
		[
			"a lower bound alone is not truncation (ShardsSkipped)",
			() => one({ FileCount: 1, ShardsSkipped: 2, MatchCount: 3 }),
			"At least 1 file, 3 matching lines.",
		],
	];

	test.each(cases)("%s", (_name, run, expected) => {
		const footer = run().split("\n---\n")[1];

		expect(footer).toBe(expected);
		expect(footer?.match(/at least/gi)?.length ?? 0).toBeLessThanOrEqual(1);
	});
});

describe("output budget", () => {
	const lines = (n: number, width = 40) =>
		Array.from({ length: n }, (_, i) => matchAt(i + 1, `${"x".repeat(width)}${i}`));
	const manyFiles = (files: number, perFile: number, width?: number) =>
		stub({
			Stats: { FileCount: files, MatchCount: files * perFile },
			FileMatches: Array.from({ length: files }, (_, i) =>
				zfile(`repo${i % 3}`, `dir/file${i}.txt`, lines(perFile, width)),
			),
		});

	test("30 files x 40 lines under maxChars=3000 stays within budget plus footer reserve", () => {
		const text = render(manyFiles(30, 40), {
			maxChars: 3000,
			maxMatchesPerFile: 50,
			contextLines: 0,
		});

		expect(text.length).toBeLessThanOrEqual(3600);
		expect(text).toContain("output budget (3000 chars) reached after");
	});

	test("the first file is always rendered, hard-clipped, even at maxChars=50", () => {
		const text = render(manyFiles(30, 40), {
			maxChars: 50,
			maxMatchesPerFile: 50,
			contextLines: 0,
		});

		expect(text).toContain("## dir/file0.txt");
		expect(text).toContain("[output truncated]");
		expect(text).toContain("output budget (50 chars)");
	});

	test("worst case: 100 files of long rows fits DEFAULT_OUTPUT_CHARS + 600", () => {
		const text = render(manyFiles(100, 50, 300), {
			maxFiles: 100,
			maxMatchesPerFile: 50,
			contextLines: 2,
		});

		expect(text.length).toBeLessThanOrEqual(DEFAULT_OUTPUT_CHARS + FOOTER_RESERVE);
		expect(text.length).toBeGreaterThan(DEFAULT_OUTPUT_CHARS / 2);
	});
});

describe("goldens", () => {
	test("normal", () => {
		const text = render(loadSearchResponse("search-multi-fragment"), { contextLines: 0 });

		expectGolden("search-normal.txt", text);
	});

	test("filename-only", () => {
		expectGolden("search-filename-only.txt", render(loadSearchResponse("search-file-only")));
	});

	test("no-match", () => {
		const text = render(stub({}), { query: "needle" });

		expectGolden("search-no-match.txt", text);
	});

	test("context", () => {
		// Inline stub: the real fixture file has 5 lines, so its context rows are always adjacent.
		const response = stub({
			Stats: { FileCount: 1, MatchCount: 2 },
			FileMatches: [
				zfile("example.test/alpha", "src/app.ts", [
					{
						LineNum: 3,
						Fragments: [{ Pre: "\t", Match: "needle", Post: "();\n" }],
						Before: "function run() {\n\n",
						After: "}\n",
					},
					{
						LineNum: 20,
						Fragments: [{ Pre: "const x = ", Match: "needle", Post: ";\n" }],
						Before: "// later\n",
						After: "export { x };\n",
					},
				]),
			],
		});
		const text = render(response);

		expectGolden("search-context.txt", text);
	});

	test("truncated-by-files", () => {
		const text = render(loadSearchResponse("search-many-files"), {
			contextLines: 0,
			maxFiles: 3,
		});

		expectGolden("search-truncated-files.txt", text);
	});

	test("truncated-by-budget", () => {
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
		const text = render(response, { contextLines: 0, maxChars: 1500 });

		expectGolden("search-truncated-budget.txt", text);
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

	test("many files: shows 3 of 8 files through the whole pipeline", async () => {
		const text = await run({ "/search": "search-many-files" }, { maxFiles: 3 }).result;

		expect(text).toContain("showing 3 of 8 files");
	});
});
