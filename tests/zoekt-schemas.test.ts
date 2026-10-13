import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { ZoektProtocolError } from "../src/zoekt/errors.js";
import { escapeRegex, exactRepoAtom, quoteArg, repoListQuery } from "../src/zoekt/query.js";
import { ApiResponseSchema } from "../src/zoekt/types.js";
import { CASES_DIR } from "./helpers/fixture-repo.js";
import { testDeps } from "./helpers/test-deps.js";
import { loadCase, mockZoektFetch } from "./helpers/zoekt-fixtures.js";

const parse = (value: unknown) => ApiResponseSchema.parse(value);

describe("tolerant schemas", () => {
	test("every captured search/repos fixture parses", () => {
		const names = readdirSync(CASES_DIR)
			.filter((f) => /^(search|list)-/.test(f) && !f.includes("error"))
			.map((f) => f.replace(/\.json$/, ""));
		expect(names.length).toBeGreaterThanOrEqual(6);
		for (const name of names) {
			const { response } = loadCase(name);
			expect(() => parse(response.body)).not.toThrow();
		}
	});

	test("FileMatches: null", () => {
		expect(parse({ result: { FileMatches: null } }).result?.FileMatches).toEqual([]);
	});

	test("Before: null and After: null", () => {
		const out = parse({
			result: {
				FileMatches: [
					{
						FileName: "a",
						Repo: "r",
						Matches: [{ LineNum: 1, Fragments: [], Before: null, After: null }],
					},
				],
			},
		});
		const match = out.result?.FileMatches[0]?.Matches[0];
		expect(match?.Before).toBe("");
		expect(match?.After).toBe("");
	});

	test("Repos: null", () => {
		expect(parse({ repos: { Repos: null, Stats: { Repos: 0 } } }).repos?.Repos).toEqual([]);
	});

	test("missing Stats", () => {
		const out = parse({ result: { FileMatches: [{ FileName: "a", Repo: "r" }] } });
		expect(out.result?.Stats).toBeUndefined();
	});

	test("Fragments: null", () => {
		const out = parse({
			result: { FileMatches: [{ FileName: "a", Repo: "r", Matches: [{ Fragments: null }] }] },
		});
		expect(out.result?.FileMatches[0]?.Matches[0]?.Fragments).toEqual([]);
	});

	test("unknown extra keys are accepted", () => {
		expect(() =>
			parse({ result: { Mystery: 1, FileMatches: [{ FileName: "a", Repo: "r", Extra: [] }] } }),
		).not.toThrow();
	});

	test("search-context: Before and After survive parsing", () => {
		const matches = parse(loadCase("search-context").response.body).result?.FileMatches.flatMap(
			(f) => f.Matches,
		);
		expect(matches?.some((m) => m.Before !== "")).toBe(true);
		expect(matches?.some((m) => m.After !== "")).toBe(true);
	});

	test("{} is rejected", () => {
		expect(() => parse({})).toThrow("neither 'result' nor 'repos'");
	});
});

describe("response union", () => {
	const clientFor = (route: string) => testDeps(mockZoektFetch({ "/search": route })).client;

	test("search() on a repos-only answer explains the repository-listing interpretation", async () => {
		const error = await clientFor("list-all")
			.search({ query: 'r:"."' })
			.catch((e: unknown) => e as Error);
		expect(error).toBeInstanceOf(ZoektProtocolError);
		expect((error as Error).message).toContain("interpreted as a repository listing");
	});

	test("listRepos() on a result answer says it expected a repository listing", async () => {
		const error = await clientFor("search-multi-fragment")
			.listRepos('r:"."')
			.catch((e: unknown) => e as Error);
		expect(error).toBeInstanceOf(ZoektProtocolError);
		expect((error as Error).message).toContain("expected repository listing");
	});
});

describe("query helpers", () => {
	test("escapeRegex", () => {
		expect(escapeRegex("a\\b.c")).toBe("a\\\\b\\.c");
		expect(escapeRegex("\\.+*?()|[]{}^$")).toBe("\\\\\\.\\+\\*\\?\\(\\)\\|\\[\\]\\{\\}\\^\\$");
		expect(escapeRegex("plain/path-1")).toBe("plain/path-1");
	});

	test("quoteArg", () => {
		expect(quoteArg('a"b\\c')).toBe('"a\\"b\\\\c"');
		expect(quoteArg("plain")).toBe('"plain"');
	});

	test("exactRepoAtom", () => {
		expect(exactRepoAtom("github.com/o/r")).toBe('r:"^github\\\\.com/o/r$"');
	});

	test("repoListQuery", () => {
		expect(repoListQuery()).toBe('r:"."');
		expect(repoListQuery("")).toBe('r:"."');
		expect(repoListQuery("api")).toBe('r:"(?i)api"');
		expect(repoListQuery("(?-i)Api")).toBe('r:"(?-i)Api"');
		expect(repoListQuery("(?:Foo|bar)")).toBe('r:"(?i)(?:Foo|bar)"');
		expect(repoListQuery("(?i)foo")).toBe('r:"(?i)foo"');
		expect(repoListQuery("(?i:foo)")).toBe('r:"(?i:foo)"');
		expect(repoListQuery("(?P<n>foo)")).toBe('r:"(?i)(?P<n>foo)"');
		expect(repoListQuery("^github\\.com/")).toBe('r:"(?i)^github\\\\.com/"');
		expect(repoListQuery('a"b')).toBe('r:"(?i)a\\"b"');
	});
});
