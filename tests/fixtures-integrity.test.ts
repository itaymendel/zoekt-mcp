import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { CASES_URL, sha256 } from "./helpers/fixture-repo.js";
import { loadCase, loadManifest } from "./helpers/zoekt-fixtures.js";

interface RawFileMatch {
	Matches: {
		LineNum: number;
		Before?: unknown;
		After?: unknown;
		Fragments: { Pre: string; Match: string; Post: string }[];
	}[];
}

const matchLines = (name: string) =>
	(
		loadCase(name).response.body as { result: { FileMatches: RawFileMatch[] } }
	).result.FileMatches.flatMap((f) => f.Matches);

describe("Zoekt fixtures", () => {
	test("search-multi-fragment has a line with 2 fragments", () => {
		const lines = matchLines("search-multi-fragment");
		const multi = lines.find((m) => m.Fragments.length === 2);
		expect(multi).toBeDefined();
		const [first, last] = multi?.Fragments ?? [];
		expect(first.Post).toBe("");
		expect(last.Post.endsWith("\n")).toBe(true);
	});

	test("search-context populates Before and After as strings", () => {
		const lines = matchLines("search-context");
		expect(lines.some((m) => typeof m.Before === "string")).toBe(true);
		expect(lines.some((m) => typeof m.After === "string")).toBe(true);
	});

	test("search-file-only matches have LineNum 0", () => {
		const lines = matchLines("search-file-only");
		expect(lines.length).toBeGreaterThan(0);
		for (const m of lines) expect(m.LineNum).toBe(0);
	});

	test("list-all uses the {repos} envelope and has no result key", () => {
		const body = loadCase("list-all").response.body as Record<string, unknown>;
		expect(body.repos).toBeDefined();
		expect("result" in body).toBe(false);
	});

	test("print-not-found body is exactly 'ambiguous result: []'", () => {
		const { response } = loadCase("print-not-found");
		expect(response.status).toBe(418);
		expect(response.bodyText?.trim()).toBe("ambiguous result: []");
	});

	test("print-ambiguous body matches /^ambiguous result: \\[.+\\]$/", () => {
		const { response } = loadCase("print-ambiguous");
		expect(response.status).toBe(418);
		expect(response.bodyText?.trim()).toMatch(/^ambiguous result: \[.+\]$/);
	});

	test("print-not-indexed-binary is 200 with NOT-INDEXED body", () => {
		const { response } = loadCase("print-not-indexed-binary");
		expect(response.status).toBe(200);
		expect(response.bodyText).toStartWith("NOT-INDEXED:");
	});

	test("search-error-parse is 418 with text body", () => {
		const { response } = loadCase("search-error-parse");
		expect(response.status).toBe(418);
		expect(response.contentType).toStartWith("text/plain");
		expect(typeof response.bodyText).toBe("string");
		expect(response.bodyText?.length).toBeGreaterThan(0);
	});

	test("MANIFEST sha256 matches every case file", () => {
		const manifest = loadManifest();
		const files = readdirSync(CASES_URL).sort();
		expect(Object.keys(manifest.cases).sort()).toEqual(files);
		for (const file of files) {
			const digest = sha256(readFileSync(new URL(file, CASES_URL)));
			expect(digest).toBe(manifest.cases[file]);
		}
	});
});
