import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	capSearch,
	clipLine,
	DEFAULT_OUTPUT_CHARS,
	FOOTER_RESERVE,
	MAX_LINE_CHARS,
	normalizeSearch,
	renderSearchText,
} from "../src/search-format.js";
import { SearchResultSchema } from "../src/zoekt/types.js";
import { expectGolden } from "./helpers/golden.js";
import { loadCase } from "./helpers/zoekt-fixtures.js";

function fixtureResponse(name: string) {
	const body = loadCase(name).response.body as { result: unknown };
	return { result: SearchResultSchema.parse(body.result) };
}

function stub(raw: unknown) {
	return { result: SearchResultSchema.parse(raw) };
}

const NOTES = readFileSync(
	new URL("./fixtures/zoekt/repos/alpha/docs/notes.txt", import.meta.url),
	"utf8",
).split("\n");

describe("normalizeSearch", () => {
	test("joins fragments into one line", () => {
		const model = normalizeSearch(fixtureResponse("search-multi-fragment"), {
			query: "handleRequest",
			contextLines: 0,
		});
		const alpha = model.files.find((f) => f.repo === "example.test/alpha");

		expect(alpha?.lines).toHaveLength(1);
		const line = alpha?.lines[0];
		expect(line?.ranges?.length).toBe(2);
		for (const [a, b] of line?.ranges ?? []) expect(line?.text.slice(a, b)).toBe("handleRequest");
		expect(line?.text).toBe("\tx := handleRequest() + handleRequest()");
	});

	test("strips the trailing newline carried by the last fragment", () => {
		const model = normalizeSearch(fixtureResponse("search-multi-fragment"), {
			query: "q",
			contextLines: 0,
		});
		for (const f of model.files) for (const l of f.lines) expect(l.text).not.toMatch(/[\r\n]$/);
		const crlf = stub({
			FileMatches: [
				{
					FileName: "a",
					Repo: "r",
					Matches: [{ LineNum: 1, Fragments: [{ Pre: "", Match: "x", Post: "\r\n" }] }],
				},
			],
		});

		expect(normalizeSearch(crlf, { query: "x", contextLines: 0 }).files[0]?.lines[0]?.text).toBe(
			"x",
		);
	});

	test("preserves indentation", () => {
		const result = stub({
			FileMatches: [
				{
					FileName: "a.go",
					Repo: "r",
					Matches: [{ LineNum: 41, Fragments: [{ Pre: "\t\t", Match: "foo", Post: "\n" }] }],
				},
			],
		});
		const line = normalizeSearch(result, { query: "foo", contextLines: 0 }).files[0]?.lines[0];

		expect(`${line?.n}:${line?.text}`).toBe("41:\t\tfoo");
	});

	test("context rows are numbered against the real file", () => {
		const model = normalizeSearch(fixtureResponse("search-context"), {
			query: "needle",
			contextLines: 2,
		});
		const lines = model.files[0]?.lines ?? [];

		expect(lines[0]?.n).toBeGreaterThanOrEqual(1);
		expect(lines.map((l) => l.n)).toEqual([1, 2, 3, 4, 5]);
		for (const l of lines) expect(l.text).toBe(NOTES[l.n - 1] as string);
		expect(lines.map((l) => l.match)).toEqual([false, true, false, true, true]);
	});

	test("contextLines=0 yields no context rows", () => {
		const model = normalizeSearch(fixtureResponse("search-context"), {
			query: "needle",
			contextLines: 0,
		});

		expect(model.files[0]?.lines.map((l) => [l.n, l.match])).toEqual([
			[2, true],
			[4, true],
			[5, true],
		]);
	});

	test("null Before/After at file start and end are handled", () => {
		const result = stub({
			FileMatches: [
				{
					FileName: "a",
					Repo: "r",
					Matches: [
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
					],
				},
			],
		});
		const lines = normalizeSearch(result, { query: "q", contextLines: 2 }).files[0]?.lines;

		expect(lines?.map((l) => `${l.n}${l.match ? ":" : "-"}${l.text}`)).toEqual([
			"1:a",
			"2-b",
			"3:c",
		]);
	});

	test("durationMs rounds nanoseconds to milliseconds", () => {
		const model = normalizeSearch(stub({ Stats: { Duration: 12_345_678 } }), {
			query: "q",
			contextLines: 0,
		});

		expect(model.durationMs).toBe(12);
	});
});

const matchAt = (n: number, text = `line ${n}`) => ({
	LineNum: n,
	Fragments: [{ Pre: "", Match: text, Post: "\n" }],
});

describe("capSearch", () => {
	test("per-file cap keeps the first K matches in Zoekt order and displays them by line", () => {
		const result = stub({
			Stats: { FileCount: 1, MatchCount: 3 },
			FileMatches: [{ FileName: "a", Repo: "r", Matches: [matchAt(90), matchAt(12), matchAt(55)] }],
		});
		const model = capSearch(
			normalizeSearch(result, { query: "q", contextLines: 0, maxMatchesPerFile: 2 }),
			{ maxFiles: 20 },
		);

		expect(model.files[0]?.lines.map((l) => l.n)).toEqual([12, 90]);
		expect(model.files[0]?.hiddenMatchLines).toBe(1);
		expect(model.truncation).toMatchObject({
			reasons: ["maxMatchesPerFile"],
			hiddenMatchLines: 1,
			moreFiles: 0,
		});
	});

	test("a hidden match shown as context is not counted as hidden", () => {
		const result = stub({
			FileMatches: [
				{
					FileName: "a",
					Repo: "r",
					Matches: [{ ...matchAt(10), After: "line 11\n" }, matchAt(11)],
				},
			],
		});
		const model = normalizeSearch(result, {
			query: "q",
			contextLines: 1,
			maxMatchesPerFile: 1,
		});

		expect(model.files[0]?.hiddenMatchLines).toBe(0);
		expect(model.files[0]?.lines.map((l) => [l.n, l.match])).toEqual([
			[10, true],
			[11, false],
		]);
	});

	test("FileCount above shown files is reported exactly", () => {
		const model = capSearch(
			normalizeSearch(fixtureResponse("search-many-files"), { query: "q", contextLines: 0 }),
			{ maxFiles: 3 },
		);

		expect(model.files).toHaveLength(3);
		expect(model.totals.files).toBe(8);
		expect(model.truncation).toMatchObject({ reasons: ["maxFiles"], moreFiles: 5 });
	});

	test("never claims truncation that did not happen", () => {
		const model = capSearch(
			normalizeSearch(fixtureResponse("search-context"), { query: "q", contextLines: 1 }),
			{ maxFiles: 20 },
		);

		expect(model.truncated).toBe(false);
		expect(model.truncation.reasons).toEqual([]);
	});

	test("maxFiles slices an over-fetched response (num = maxFiles + 1)", () => {
		const model = capSearch(
			normalizeSearch(fixtureResponse("search-many-files"), { query: "q", contextLines: 0 }),
			{ maxFiles: 2 },
		);

		expect(model.files).toHaveLength(2);
		expect(model.truncation.moreFiles).toBe(6);
	});

	test("FilesSkipped or ShardsSkipped marks the file total as a lower bound", () => {
		for (const Stats of [{ FilesSkipped: 1 }, { ShardsSkipped: 2 }, {}]) {
			const model = normalizeSearch(stub({ Stats }), { query: "q", contextLines: 0 });

			expect(model.totals.filesIsLowerBound).toBe(Object.keys(Stats).length > 0);
		}
	});
});

// ---- rendering ----

interface RunOptions {
	contextLines?: number;
	maxMatchesPerFile?: number;
	maxFiles?: number;
	maxChars?: number;
}

function render(response: ReturnType<typeof stub>, o: RunOptions = {}) {
	const maxMatchesPerFile = o.maxMatchesPerFile ?? 5;
	const model = capSearch(
		normalizeSearch(response, {
			query: "q",
			contextLines: o.contextLines ?? 2,
			maxMatchesPerFile,
		}),
		{ maxFiles: o.maxFiles ?? 20, maxChars: o.maxChars },
	);
	return { model, text: renderSearchText(model, { maxChars: o.maxChars, maxMatchesPerFile }) };
}

const zfile = (repo: string, path: string, matches: unknown[], branches = ["HEAD"]) => ({
	Repo: repo,
	FileName: path,
	Branches: branches,
	Matches: matches,
});

const hasLoneSurrogate = (s: string) =>
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe("renderSearchText", () => {
	const multi = () => fixtureResponse("search-multi-fragment");

	test("groups by repo", () => {
		const response = stub({
			FileMatches: [
				zfile("r1", "a", [matchAt(1)]),
				zfile("r2", "b", [matchAt(1)]),
				zfile("r1", "c", [matchAt(1)]),
			],
		});
		const text = render(response).text;

		expect(text.match(/^# .*$/gm)).toEqual(["# r1", "# r2"]);
		expect(text.indexOf("## c")).toBeLessThan(text.indexOf("# r2"));
	});

	test("repo and path on separate lines", () => {
		const text = render(multi(), { contextLines: 0 }).text;

		expect(text).toContain("# example.test/alpha\n## src/handler.go");
		expect(text).not.toContain("example.test/alpha/src/handler.go");
	});

	test("rows are N:text, with indentation and one row for a multi-fragment line", () => {
		const text = render(multi(), { contextLines: 0 }).text;

		expect(text).toContain("4:\tx := handleRequest() + handleRequest()\n");
		expect(text.match(/^4:/gm)).toHaveLength(2); // one per file, not one per fragment
		expect(text).not.toMatch(/^> /m);
	});

	test("omits HEAD branch", () => {
		const text = render(multi(), { contextLines: 0 }).text;

		expect(text).toContain("## src/handler.go\n"); // beta, HEAD only
		expect(text).not.toContain("(branches: HEAD");
	});

	test("shows the branch list when files differ, in the stored order", () => {
		const text = render(multi(), { contextLines: 0 }).text;

		expect(text).toContain("## src/handler.go  (branches: main, main-old, feature)");
	});

	test("omits branch list when uniform across results", () => {
		const text = render(fixtureResponse("search-context")).text;

		expect(text).not.toContain("branches");
		expect(text).toContain("## docs/notes.txt\n");
	});

	test("non-adjacent groups are separated by --, adjacent rows are not", () => {
		const response = stub({
			FileMatches: [zfile("r", "a", [{ ...matchAt(10), After: "ctx\n" }, matchAt(30)])],
		});
		const rows = render(response, { contextLines: 1 }).text.split("\n");

		expect(rows.slice(1, 6)).toEqual(["## a", "10:line 10", "11-ctx", "--", "30:line 30"]);
	});

	test("context fixture renders - rows and : rows numbered like the real file", () => {
		const text = render(fixtureResponse("search-context")).text;
		const rows = text.split("\n").filter((l) => /^\d+[:-]/.test(l));

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
		const text = render(fixtureResponse("search-file-only")).text;

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
		const text = render(response).text;

		expect(text).toContain("## bin.dat  [not indexed: binary/too large]");
		expect(text).not.toContain("1:");
	});

	test("no match", () => {
		const text = renderSearchText(normalizeSearch(stub({}), { query: "needle", contextLines: 2 }));

		expect(text).toBe("No matches for `needle`.");
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
			.text.split("\n")
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
			const clipped = clipLine(text, [[before * 2, before * 2 + 6]]);

			expect(hasLoneSurrogate(clipped)).toBe(false);
			expect(clipped).toContain("NEEDLE");
			expect(clipped.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
		}
		expect(hasLoneSurrogate(clipLine("😀".repeat(400)))).toBe(false);
	});

	test("overflow row counts hidden matching lines", () => {
		const two = stub({ FileMatches: [zfile("r", "a", [matchAt(1), matchAt(2)])] });
		const three = stub({ FileMatches: [zfile("r", "a", [matchAt(1), matchAt(2), matchAt(3)])] });

		expect(render(two, { maxMatchesPerFile: 1 }).text).toContain(
			"[+1 more matching line in this file]",
		);
		expect(render(three, { maxMatchesPerFile: 1 }).text).toContain(
			"[+2 more matching lines in this file]",
		);
	});

	test("per-file cap [90,12,55] with K=2 shows 12 and 90 and one hidden line", () => {
		const response = stub({
			FileMatches: [zfile("r", "a", [matchAt(90), matchAt(12), matchAt(55)])],
		});
		const text = render(response, { contextLines: 0, maxMatchesPerFile: 2 }).text;

		expect(text).toContain(
			"## a\n12:line 12\n--\n90:line 90\n[+1 more matching line in this file]",
		);
		expect(text).toContain("hidden by maxMatchesPerFile=2");
	});

	test("complete results have a plain footer", () => {
		const text = render(multi(), { contextLines: 0 }).text;

		expect(text.endsWith("\n\n---\n2 files, 2 matching lines.")).toBe(true);
		expect(text).not.toMatch(/ms\)|Stats:/);
	});

	test("FileCount above shown files is reported exactly", () => {
		const text = render(fixtureResponse("search-many-files"), {
			contextLines: 0,
			maxFiles: 3,
		}).text;

		expect(text).toContain("Truncated: showing 3 of 8 files.");
		expect(text).toContain(
			"Refine with repo:, file:, lang: or -file: filters, or raise maxFiles / maxMatchesPerFile.",
		);
	});

	test("FilesSkipped>0 reports 'of at least'", () => {
		const response = stub({
			Stats: { FileCount: 4, FilesSkipped: 12, MatchCount: 4 },
			FileMatches: [zfile("r", "a", [matchAt(1)]), zfile("r", "b", [matchAt(1)])],
		});
		const text = render(response, { maxFiles: 2 }).text;

		expect(text).toContain("Truncated: showing 2 of at least 4 files.");
	});

	test("lower bound without any cut is not reported as truncation", () => {
		const response = stub({
			Stats: { FileCount: 1, FilesSkipped: 1, MatchCount: 1 },
			FileMatches: [zfile("r", "a", [matchAt(1)])],
		});
		const { model, text } = render(response);

		expect(model.truncated).toBe(false);
		expect(text).not.toContain("Truncated");
		expect(text).toContain("At least 1 file, 1 matching line.");
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
		const { model, text } = render(manyFiles(30, 40), {
			maxChars: 3000,
			maxMatchesPerFile: 50,
			contextLines: 0,
		});

		expect(text.length).toBeLessThanOrEqual(3600);
		expect(text).toContain("output budget (3000 chars) reached after");
		expect(model.truncation.reasons).toContain("outputBudget");
		expect(model.truncation.filesOmittedByBudget).toBeGreaterThan(0);
	});

	test("the first file is always rendered, hard-clipped, even at maxChars=50", () => {
		const { text } = render(manyFiles(30, 40), {
			maxChars: 50,
			maxMatchesPerFile: 50,
			contextLines: 0,
		});

		expect(text).toContain("## dir/file0.txt");
		expect(text).toContain("[output truncated]");
		expect(text).toContain("output budget (50 chars)");
	});

	test("worst case: 100 files of long rows fits DEFAULT_OUTPUT_CHARS + 600", () => {
		const { text } = render(manyFiles(100, 50, 300), {
			maxFiles: 100,
			maxMatchesPerFile: 50,
			contextLines: 2,
		});

		expect(text.length).toBeLessThanOrEqual(DEFAULT_OUTPUT_CHARS + FOOTER_RESERVE);
		expect(text.length).toBeGreaterThan(DEFAULT_OUTPUT_CHARS / 2);
	});

	test("a result that fits is not marked truncated", () => {
		const { model } = render(manyFiles(3, 3));

		expect(model.truncated).toBe(false);
	});
});

describe("goldens", () => {
	test("normal", () => {
		const { text } = render(fixtureResponse("search-multi-fragment"), { contextLines: 0 });

		expectGolden("search-normal.txt", text);
	});

	test("filename-only", () => {
		expectGolden("search-filename-only.txt", render(fixtureResponse("search-file-only")).text);
	});

	test("no-match", () => {
		const text = renderSearchText(normalizeSearch(stub({}), { query: "needle", contextLines: 2 }));

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
		const { text } = render(response);

		expect(text).toMatch(/^\d+-/m);
		expect(text).toMatch(/^\d+:/m);
		expect(text).toMatch(/^--$/m);
		expectGolden("search-context.txt", text);
	});

	test("truncated-by-files", () => {
		const { text } = render(fixtureResponse("search-many-files"), {
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
		const { text } = render(response, { contextLines: 0, maxChars: 1500 });

		expectGolden("search-truncated-budget.txt", text);
	});
});
