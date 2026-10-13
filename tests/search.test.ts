import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { capSearch, normalizeSearch } from "../src/search-format.js";
import { SearchResultSchema } from "../src/zoekt/types.js";
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
