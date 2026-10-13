import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { normalizeSearch } from "../src/search-format.js";
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
