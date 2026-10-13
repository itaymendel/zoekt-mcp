import { afterEach, describe, expect, test } from "bun:test";
import { MAX_FETCH_BYTES } from "../src/file-format.js";
import { listReposOutputSchema } from "../src/tools/list-repos.js";
import { readFileOutputSchema } from "../src/tools/read-file.js";
import { searchOutputSchema } from "../src/tools/search.js";
import { connectTestClient, resultText, type TestMcp } from "./helpers/mcp.js";
import { testDeps } from "./helpers/test-deps.js";
import { mockZoektFetch, type ZoektRoutes } from "./helpers/zoekt-fixtures.js";

const ALPHA = "example.test/alpha";

let mcp: TestMcp | undefined;
afterEach(async () => {
	await mcp?.close();
	mcp = undefined;
});

async function call(name: string, routes: ZoektRoutes, args: Record<string, unknown> = {}) {
	mcp = await connectTestClient(testDeps(mockZoektFetch(routes)));
	const result = await mcp.client.callTool({ name, arguments: args });
	return { result, text: resultText(result), data: result.structuredContent as unknown };
}

const printing = (body: string) => ({ "/print": () => new Response(body) });
const noMatch = () =>
	Response.json({
		result: { FileMatches: [], Stats: { Duration: 0, FileCount: 0, MatchCount: 0 } },
	});

describe("tools/list", () => {
	test("every tool advertises an object outputSchema", async () => {
		mcp = await connectTestClient(testDeps(mockZoektFetch({})));
		const { tools } = await mcp.client.listTools();

		expect(tools.map((t) => t.name).sort()).toEqual(["list_repos", "read_file", "search"]);
		for (const tool of tools) {
			expect(tool.outputSchema?.type).toBe("object");
			expect(Object.keys(tool.outputSchema?.properties ?? {}).length).toBeGreaterThan(3);
		}
	});

	test("outputSchemas are stable public contracts", async () => {
		mcp = await connectTestClient(testDeps(mockZoektFetch({})));
		const { tools } = await mcp.client.listTools();
		const keys = (name: string) =>
			Object.keys(tools.find((t) => t.name === name)?.outputSchema?.properties ?? {}).sort();

		expect(keys("search")).toEqual([
			"files",
			"query",
			"totalFiles",
			"totalFilesIsLowerBound",
			"totalMatches",
			"truncated",
			"truncation",
		]);
		expect(keys("list_repos")).toEqual([
			"filter",
			"limit",
			"nextOffset",
			"offset",
			"repos",
			"total",
			"truncated",
		]);
		expect(keys("read_file")).toEqual([
			"branch",
			"endLine",
			"lines",
			"nextStartLine",
			"path",
			"repo",
			"startLine",
			"totalLines",
			"totalLinesIsLowerBound",
			"truncated",
			"truncationReason",
		]);
	});
});

describe("search structuredContent", () => {
	test("matches with context mirror the text and omit rendering internals", async () => {
		const { result, text, data } = await call(
			"search",
			{ "/search": "search-context" },
			{ query: "needle", contextLines: 2 },
		);
		const out = searchOutputSchema.parse(data);

		expect(result.isError).toBeFalsy();
		expect(text).toContain("2:needle one");
		expect(out.truncated).toBe(false);
		expect(out.files.length).toBeGreaterThan(0);
		const first = out.files[0];
		expect(first?.lines.some((l) => l.isMatch)).toBe(true);
		expect(first?.lines.some((l) => !l.isMatch)).toBe(true);
		expect(Object.keys(data as object)).not.toContain("blocks");
		expect(Object.keys(data as object)).not.toContain("limits");
		expect(JSON.stringify(data)).not.toContain('"ranges"');
	});

	test("no matches", async () => {
		const { text, data } = await call("search", { "/search": noMatch }, { query: "zzz" });

		expect(text).toBe("No matches for `zzz`.");
		expect(data).toEqual({
			query: "zzz",
			files: [],
			totalFiles: 0,
			totalFilesIsLowerBound: false,
			totalMatches: 0,
			truncated: false,
			truncation: { reasons: [], moreFiles: 0, hiddenMatchLines: 0, filesOmittedByBudget: 0 },
		});
	});

	test("truncated by maxFiles", async () => {
		const { text, data } = await call(
			"search",
			{ "/search": "search-many-files" },
			{ query: "needle", maxFiles: 3, contextLines: 0 },
		);
		const out = searchOutputSchema.parse(data);

		expect(text).toContain("showing 3 of 8 files");
		expect(out.truncated).toBe(true);
		expect(out.files).toHaveLength(3);
		expect(out.totalFiles).toBe(8);
		expect(out.truncation.reasons).toContain("maxFiles");
		expect(out.truncation.moreFiles).toBe(5);
	});

	test("truncated by maxMatchesPerFile", async () => {
		const threeMatches = () =>
			Response.json({
				result: {
					Stats: { FileCount: 1, MatchCount: 3 },
					FileMatches: [
						{
							FileName: "a.ts",
							Repo: ALPHA,
							Matches: [10, 20, 30].map((n) => ({
								LineNum: n,
								Fragments: [{ Pre: "", Match: "needle", Post: "\n" }],
							})),
						},
					],
				},
			});
		const { data } = await call(
			"search",
			{ "/search": threeMatches },
			{ query: "needle", maxMatchesPerFile: 1, contextLines: 0 },
		);
		const out = searchOutputSchema.parse(data);

		expect(out.truncation.reasons).toContain("maxMatchesPerFile");
		expect(out.truncation.hiddenMatchLines).toBe(2);
		expect(out.files[0]?.hiddenMatchLines).toBe(2);
		for (const f of out.files) expect(f.lines.filter((l) => l.isMatch)).toHaveLength(1);
	});

	test("filename-only hit", async () => {
		const { data } = await call("search", { "/search": "search-file-only" }, { query: "notes" });
		const out = searchOutputSchema.parse(data);

		expect(out.files[0]).toMatchObject({ path: "docs/notes.txt", filenameMatch: true, lines: [] });
	});

	test("an over-long line is clipped", async () => {
		const long = "x".repeat(5000);
		const { data } = await call(
			"search",
			{
				"/search": () =>
					Response.json({
						result: {
							Stats: { FileCount: 1, MatchCount: 1 },
							FileMatches: [
								{
									FileName: "a.min.js",
									Repo: ALPHA,
									Matches: [{ LineNum: 1, Fragments: [{ Pre: "", Match: long, Post: "\n" }] }],
								},
							],
						},
					}),
			},
			{ query: "x" },
		);
		const out = searchOutputSchema.parse(data);

		expect(out.files[0]?.lines[0]?.text.length).toBeLessThanOrEqual(2000);
	});
});

describe("list_repos structuredContent", () => {
	test("all repositories", async () => {
		const { text, data } = await call("list_repos", { "/search": "list-all" });
		const out = listReposOutputSchema.parse(data);

		expect(text).toContain("indexed");
		expect(out.truncated).toBe(false);
		expect(out.nextOffset).toBeUndefined();
		expect(out.total).toBe(out.repos.length);
		expect(out.repos.length).toBeGreaterThan(0);
		expect(out.repos[0]?.branches[0]).toEqual({
			name: expect.any(String),
			sha: expect.any(String),
		});
	});

	test("paging reports nextOffset; an empty listing is valid", async () => {
		const names = Array.from({ length: 6 }, (_, i) => `org/repo-${i + 1}`);
		const route = (url: URL) => {
			const num = Number(url.searchParams.get("num"));
			return Response.json({
				repos: {
					Stats: { Repos: names.length },
					Repos: names.slice(0, num).map((Name) => ({ Name, Files: 1, Size: 10 })),
				},
			});
		};
		const page = await call("list_repos", { "/search": route }, { limit: 2, offset: 2 });
		const out = listReposOutputSchema.parse(page.data);

		expect(out).toMatchObject({ total: 6, offset: 2, limit: 2, truncated: true, nextOffset: 4 });
		expect(out.repos.map((r) => r.name)).toEqual(["org/repo-3", "org/repo-4"]);

		const empty = await call(
			"list_repos",
			{ "/search": () => Response.json({ repos: { Repos: null } }) },
			{ filter: "nope" },
		);
		expect(listReposOutputSchema.parse(empty.data)).toEqual({
			filter: "nope",
			total: 0,
			offset: 0,
			limit: 50,
			truncated: false,
			repos: [],
		});
	});
});

describe("read_file structuredContent", () => {
	test("a small file", async () => {
		const { text, data } = await call(
			"read_file",
			{ "/print": "print-ok" },
			{ repo: ALPHA, path: "docs/notes.txt" },
		);
		const out = readFileOutputSchema.parse(data);

		expect(text).toStartWith("# example.test/alpha\n## docs/notes.txt  (5 lines)\n1:first line\n");
		expect(out).toMatchObject({
			repo: ALPHA,
			path: "docs/notes.txt",
			startLine: 1,
			endLine: 5,
			totalLines: 5,
			totalLinesIsLowerBound: false,
			truncated: false,
		});
		expect(out.lines[0]).toEqual({ line: 1, text: "first line" });
		expect(out.lines).toHaveLength(5);
		expect(out.nextStartLine).toBeUndefined();
	});

	test("a window continues at nextStartLine", async () => {
		const body = `${Array.from({ length: 1200 }, (_, i) => `l${i + 1}`).join("\n")}\n`;
		const { data } = await call("read_file", printing(body), {
			repo: ALPHA,
			path: "big.ts",
			startLine: 11,
			endLine: 20,
		});
		const out = readFileOutputSchema.parse(data);

		expect(out).toMatchObject({
			startLine: 11,
			endLine: 20,
			totalLines: 1200,
			truncated: true,
			truncationReason: "window",
			nextStartLine: 21,
		});
		expect(out.lines.map((l) => l.line)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
		expect(out.lines[0]?.text).toBe("l11");
	});

	test("the character cap", async () => {
		const wide = Array.from({ length: 200 }, (_, i) => `${i}`.padEnd(1500, "x")).join("\n");
		const { data } = await call("read_file", printing(`${wide}\n`), {
			repo: ALPHA,
			path: "wide.txt",
			endLine: 200,
		});
		const out = readFileOutputSchema.parse(data);

		expect(out.truncationReason).toBe("chars");
		expect(out.nextStartLine).toBe(out.endLine + 1);
		expect(out.lines).toHaveLength(out.endLine);
	});

	test("a text line containing a colon keeps its text", async () => {
		const { data } = await call("read_file", printing("a: b: c\n"), { repo: ALPHA, path: "c.txt" });

		expect(readFileOutputSchema.parse(data).lines).toEqual([{ line: 1, text: "a: b: c" }]);
	});

	test("the fetch cap", async () => {
		const line = `${"z".repeat(63)}\n`;
		const body = line.repeat(Math.ceil((MAX_FETCH_BYTES + 1024) / line.length));
		const { data } = await call("read_file", printing(body), {
			repo: ALPHA,
			path: "huge.log",
			startLine: 131_000,
			endLine: 131_001,
		});
		const out = readFileOutputSchema.parse(data);

		expect(out.totalLinesIsLowerBound).toBe(true);
		expect(out.truncated).toBe(true);
	});

	test("empty file and past the end have no lines", async () => {
		const empty = await call("read_file", printing(""), { repo: ALPHA, path: "e.txt" });
		expect(readFileOutputSchema.parse(empty.data)).toMatchObject({
			startLine: 1,
			endLine: 0,
			totalLines: 0,
			lines: [],
			truncated: false,
		});

		const past = await call("read_file", printing("a\nb\n"), {
			repo: ALPHA,
			path: "p.txt",
			startLine: 10,
		});
		expect(readFileOutputSchema.parse(past.data)).toMatchObject({
			endLine: 9,
			totalLines: 2,
			lines: [],
		});
	});

	test("branch is echoed", async () => {
		const { data } = await call("read_file", printing("x\n"), {
			repo: ALPHA,
			path: "a.ts",
			branch: "HEAD",
		});

		expect(readFileOutputSchema.parse(data).branch).toBe("HEAD");
	});
});

describe("no data beyond the text", () => {
	test("repo URLs with credentials and metadata never reach the result", async () => {
		const route = () =>
			Response.json({
				repos: {
					Stats: { Repos: 1 },
					Repos: [
						{
							Name: "org/r",
							URL: "https://user:secret@example.test/r.git",
							Metadata: { token: "secret" },
							Branches: [
								{
									Name: "HEAD",
									Version: "a".repeat(40),
									URL: "https://user:secret@example.test/r.git",
								},
							],
							Files: 1,
							Size: 1,
						},
					],
				},
			});
		const { result, data } = await call("list_repos", { "/search": route });

		expect(listReposOutputSchema.parse(data).repos[0]?.name).toBe("org/r");
		expect(JSON.stringify(result)).not.toContain("secret");
	});
});

describe("errors carry no structuredContent", () => {
	test("a failing tool returns isError and text only", async () => {
		const { result, text } = await call("read_file", printing("ab\0cd"), {
			repo: ALPHA,
			path: "x.bin",
		});

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
		expect(text).toContain("looks binary");
	});
});
