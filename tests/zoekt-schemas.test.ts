import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { exactRepoAtom, repoListQuery } from "../src/zoekt/query.js";
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

	test("Go nulls, omitted fields and unknown keys are tolerated", () => {
		expect(parse({ result: { FileMatches: null } }).result?.FileMatches).toEqual([]);
		expect(parse({ repos: { Repos: null, Stats: { Repos: 0 } } }).repos?.Repos).toEqual([]);

		const out = parse({
			result: {
				Mystery: 1,
				FileMatches: [
					{
						FileName: "a",
						Repo: "r",
						Extra: [],
						Matches: [
							{ LineNum: 1, Fragments: [], Before: null, After: null },
							{ Fragments: null },
						],
					},
				],
			},
		});
		const [first, second] = out.result?.FileMatches[0]?.Matches ?? [];
		expect(out.result?.Stats).toBeUndefined();
		expect([first?.Before, first?.After]).toEqual(["", ""]);
		expect(second?.Fragments).toEqual([]);
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
		expect((error as Error).message).toContain("interpreted as a repository listing");
	});

	test("listRepos() on a result answer says it expected a repository listing", async () => {
		const error = await clientFor("search-multi-fragment")
			.listRepos('r:"."')
			.catch((e: unknown) => e as Error);
		expect((error as Error).message).toContain("expected repository listing");
	});
});

describe("query helpers", () => {
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
