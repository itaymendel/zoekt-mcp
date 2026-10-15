import { afterEach, describe, expect, test } from "bun:test";
import { MAX_FETCH_BYTES } from "../src/file-format.js";
import { expectGolden } from "./helpers/golden.js";
import { connectTestClient, resultText, type TestMcp } from "./helpers/mcp.js";
import { testDeps } from "./helpers/test-deps.js";
import { mockZoektFetch, type ZoektRoutes } from "./helpers/zoekt-fixtures.js";

const ALPHA = "example.test/alpha";

let mcp: TestMcp | undefined;
afterEach(async () => {
	await mcp?.close();
	mcp = undefined;
});

async function callRead(routes: ZoektRoutes, args: Record<string, unknown>) {
	const fetch = mockZoektFetch(routes);
	mcp = await connectTestClient(testDeps(fetch));
	const result = await mcp.client.callTool({ name: "read_file", arguments: args });
	return {
		result,
		text: resultText(result),
		fetch,
	};
}

const printing = (body: string) => ({ "/print": () => new Response(body) });
const numbered = (n: number, line = (i: number) => `line ${i}`) =>
	`${Array.from({ length: n }, (_, i) => line(i + 1)).join("\n")}\n`;
const noRepos = () => Response.json({ repos: { Repos: [] } });
const rows = (text: string) => text.split("\n").filter((l) => /^\d+:/.test(l));

describe("read_file output", () => {
	test("returns numbered lines for a small file", async () => {
		const { text, result } = await callRead(
			{ "/print": "print-ok" },
			{ repo: ALPHA, path: "docs/notes.txt" },
		);

		expect(result.isError).toBeFalsy();
		expect(text).toStartWith("# example.test/alpha\n## docs/notes.txt  (5 lines)\n1:first line\n");
		expect(text).toEndWith("5:needle three\n\n---\nEnd of file.");
		expectGolden("read-file-ok.txt", text);
	});

	test("default window", async () => {
		const { text, fetch } = await callRead(printing(numbered(1200)), {
			repo: ALPHA,
			path: "big.ts",
		});

		expect(text).toContain("\n500:line 500\n");
		expect(text).not.toContain("501:");
		expect(text).toEndWith("Truncated: showing lines 1-500 of 1200. Continue with startLine=501.");
		expect(fetch.requests).toHaveLength(1);
	});

	test("explicit range", async () => {
		const { text } = await callRead(printing(numbered(50)), {
			repo: ALPHA,
			path: "a.ts",
			startLine: 10,
			endLine: 12,
		});

		expect(text).toContain("\n10:line 10\n11:line 11\n12:line 12\n");
		expect(text).toEndWith("Truncated: showing lines 10-12 of 50. Continue with startLine=13.");
	});

	test("clamps huge ranges", async () => {
		const { text } = await callRead(printing(numbered(5000)), {
			repo: ALPHA,
			path: "a.ts",
			endLine: 5000,
		});

		expect(rows(text)).toHaveLength(2000);
		expect(text).toEndWith("Continue with startLine=2001.");
	});

	test("char cap", async () => {
		const wide = (i: number) => `${i}`.padEnd(1500, "x");
		const { text } = await callRead(printing(numbered(200, wide)), {
			repo: ALPHA,
			path: "wide.txt",
			endLine: 200,
		});

		expect(text.length).toBeLessThanOrEqual(40_300);
		const last = rows(text).length;
		expect(last).toBeLessThan(200);
		expect(text).toEndWith(
			`\n\n---\nTruncated: showing lines 1-${last} of 200. Continue with startLine=${last + 1}.`,
		);
	});

	test("long line clipped", async () => {
		const { text } = await callRead(printing(`${"y".repeat(2500)}\nshort\n`), {
			repo: ALPHA,
			path: "long.min.js",
		});

		expect(text).toContain(`1:${"y".repeat(2000)}…[+500 chars]\n2:short\n`);
	});

	test("CRLF", async () => {
		const { text } = await callRead(printing("a\r\nb\r\n"), { repo: ALPHA, path: "w.txt" });

		expect(text).not.toContain("\r");
		expect(text).toContain("\n1:a\n2:b\n");
		expect(text).toContain("(2 lines)");
	});

	test("path cleanup", async () => {
		const first = await callRead(printing("x\n"), { repo: ALPHA, path: "./src/main.ts" });
		const second = await callRead(printing("x\n"), { repo: ALPHA, path: "/src/main.ts" });

		expect(first.fetch.requests[0]?.searchParams.get("f")).toBe("src/main.ts");
		expect(second.fetch.requests[0]?.searchParams.get("f")).toBe("src/main.ts");
	});

	test("past end", async () => {
		const { text, result } = await callRead(printing(numbered(3)), {
			repo: ALPHA,
			path: "a.ts",
			startLine: 10,
		});

		expect(result.isError).toBeFalsy();
		expect(text).toContain("startLine=10 is past the end of the file (3 lines).");
	});

	test("empty file", async () => {
		const { text } = await callRead(printing(""), { repo: ALPHA, path: "empty.txt" });

		expect(text).toContain("(0 lines)");
		expect(text).toContain("The file is empty.");
	});

	test("NUL bytes are refused", async () => {
		const { result, text } = await callRead(printing("ab\0cd"), { repo: ALPHA, path: "x.bin" });

		expect(result.isError).toBe(true);
		expect(text).toContain("looks binary");
	});

	test("a file over the fetch cap reports that later lines are unavailable", async () => {
		const line = `${"z".repeat(63)}\n`;
		const body = line.repeat(Math.ceil((MAX_FETCH_BYTES + 1024) / line.length));
		const { text } = await callRead(printing(body), {
			repo: ALPHA,
			path: "huge.log",
			startLine: 131_000,
			endLine: 131_001,
		});

		expect(text).toContain("(at least ");
		expect(text).toContain("131000:zzz");
		expect(text).toContain("Truncated: showing lines 131000-131001 of at least ");
	});

	test("reading to the last readable line of a fetch-capped file is not End of file", async () => {
		const line = `${"z".repeat(63)}\n`;
		const body = line.repeat(Math.ceil((MAX_FETCH_BYTES + 1024) / line.length));
		const { text } = await callRead(printing(body), {
			repo: ALPHA,
			path: "huge.log",
			startLine: 131_000,
			endLine: 132_999,
		});

		expect(text).toMatch(/Truncated: showing lines 131000-\d+ of at least \d+\. Continue with/);
		expect(text).not.toContain("End of file.");
	});

	test("end before start makes zero fetches", async () => {
		const { result, text, fetch } = await callRead(printing("x\n"), {
			repo: ALPHA,
			path: "a.ts",
			startLine: 10,
			endLine: 5,
		});

		expect(result.isError).toBe(true);
		expect(text).toBe("read_file error: endLine (5) must not be before startLine (10).");
		expect(fetch.requests).toHaveLength(0);
	});
});

describe("read_file errors", () => {
	test("unknown branch is rejected after one listRepos, without /print", async () => {
		const { text, result, fetch } = await callRead(
			{ "/search": "list-all", "/print": "print-ok" },
			{ repo: ALPHA, path: "docs/notes.txt", branch: "nope" },
		);

		expect(result.isError).toBe(true);
		expect(text).toStartWith(
			'read_file error: Branch "nope" is not indexed for example.test/alpha.',
		);
		expect(fetch.requests.map((u) => u.pathname)).toEqual(["/search"]);
	});

	test("file not found names the file", async () => {
		const { text } = await callRead(
			{ "/print": "print-not-found", "/search": "list-all" },
			{ repo: ALPHA, path: "nope.txt" },
		);

		expect(text).toStartWith("read_file error: File not found: example.test/alpha:nope.txt.");
		expect(text).toContain("search with `f:`");
	});

	test("unknown repository, with or without a branch", async () => {
		for (const branch of [undefined, "main"]) {
			const { text } = await callRead(
				{ "/print": "print-not-found", "/search": noRepos },
				{ repo: "example.test/zzz", path: "nope.txt", branch },
			);

			expect(text).toStartWith("read_file error: Repository not found: example.test/zzz.");
			await mcp?.close();
			mcp = undefined;
		}
	});

	test("ambiguous without branch", async () => {
		const { text } = await callRead(
			{ "/print": "print-ambiguous", "/search": "list-all" },
			{ repo: ALPHA, path: "Makefile" },
		);

		expect(text).toBe(
			"read_file error: Multiple indexed versions of example.test/alpha:Makefile exist (content differs between branches). Pass branch. Indexed branches: main, main-old, feature.",
		);
	});

	test("ambiguous with the default branch as a substring suggests HEAD", async () => {
		const { text } = await callRead(
			{ "/print": "print-ambiguous", "/search": "list-all" },
			{ repo: ALPHA, path: "Makefile", branch: "main" },
		);

		expect(text).toContain('match branch "main"');
		expect(text).toContain('Pass branch: "HEAD" to read the default branch.');
		expect(text).toContain("Indexed branches: main, main-old, feature.");
	});

	test("not indexed binary", async () => {
		const { text, result } = await callRead(
			{ "/print": "print-not-indexed-binary" },
			{ repo: "example.test/delta", path: "bin.dat" },
		);

		expect(result.isError).toBe(true);
		expect(text).toBe(
			"read_file error: File is not indexed by Zoekt (contains binary content): example.test/delta:bin.dat. read_file returns indexed text files only.",
		);
		expect(text).not.toContain("1:NOT-INDEXED");
	});

	test("not indexed large", async () => {
		const { text, result } = await callRead(
			printing("NOT-INDEXED: exceeds the maximum size limit"),
			{ repo: ALPHA, path: "big.sql" },
		);

		expect(result.isError).toBe(true);
		expect(text).toContain("exceeds the maximum size limit): example.test/alpha:big.sql.");
		expect(text).not.toContain("1:NOT-INDEXED");
	});
});
