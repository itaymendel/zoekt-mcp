import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { normalizeRepoList } from "../src/tools/list-repos.js";
import { formatBytes, formatRepoList, redactUrl } from "../src/utils.js";
import { RepoListWireSchema } from "../src/zoekt/types.js";
import { startFakeZoekt } from "./helpers/fake-zoekt.js";
import { connectTestClient, resultText, type TestMcp } from "./helpers/mcp.js";
import { testDeps } from "./helpers/test-deps.js";
import { loadCase, mockZoektFetch } from "./helpers/zoekt-fixtures.js";

const GOLDEN = new URL("./golden/repos-all.txt", import.meta.url);

let mcp: TestMcp | undefined;
afterEach(async () => {
	await mcp?.close();
	mcp = undefined;
});

async function callListRepos(
	routes: Parameters<typeof mockZoektFetch>[0],
	args: Record<string, unknown> = {},
) {
	const fetch = mockZoektFetch(routes);
	mcp = await connectTestClient(testDeps(fetch));
	const result = await mcp.client.callTool({ name: "list_repos", arguments: args });
	return { result, text: resultText(result), fetch };
}

const sha = (c: string) => c.repeat(40);

function repoEntry(name: string, extra: Record<string, unknown> = {}) {
	return {
		Name: name,
		URL: "",
		IndexTime: "2025-03-04T05:06:07Z",
		Branches: [{ Name: "HEAD", Version: sha("a"), URL: "" }],
		Files: 3,
		Metadata: null,
		Size: 2048,
		MemorySize: 1,
		...extra,
	};
}

/** A Zoekt stub holding `names`, honoring `num` the way Zoekt does (Stats.Repos is pre-num). */
function stubRepos(names: string[]) {
	return (url: URL) => {
		const num = Number(url.searchParams.get("num") ?? names.length);
		return Response.json({
			repos: {
				Stats: { Repos: names.length },
				Repos: names.slice(0, num).map((n) => repoEntry(n)),
			},
		});
	};
}

describe("list_repos requests", () => {
	test('{} lists everything: r:".", num=50, order=name', async () => {
		const { fetch, text, result } = await callListRepos({ "/search": "list-all" });
		const params = fetch.requests[0]?.searchParams;

		expect(result.isError).toBeFalsy();
		expect(params?.get("q")).toBe(loadCase("list-all").request.query.q as string);
		expect(params?.get("q")).toBe('r:"."');
		expect(params?.get("num")).toBe("50");
		expect(params?.get("order")).toBe("name");
		expect(params?.get("format")).toBe("json");
		expect(text.startsWith("3 repositories indexed")).toBe(true);
	});

	test.each([
		["api", 'r:"(?i)api"'],
		["(?-i)Api", 'r:"(?-i)Api"'],
		["^github\\.com/", 'r:"(?i)^github\\\\.com/"'],
		['a"b', 'r:"(?i)a\\"b"'],
	])("filter %p -> q=%p", async (filter, q) => {
		const { fetch } = await callListRepos({ "/search": "list-all" }, { filter });

		expect(fetch.requests[0]?.searchParams.get("q")).toBe(q);
	});

	test("the escaped filter decodes to the regex the user typed", async () => {
		const { fetch } = await callListRepos({ "/search": "list-all" }, { filter: "^github\\.com/" });
		const q = fetch.requests[0]?.searchParams.get("q") as string;

		// Zoekt drops one backslash level inside quotes.
		expect(q.replaceAll("\\\\", "\\")).toBe('r:"(?i)^github\\.com/"');
	});

	test("list-filter replay: the request equals the captured case", async () => {
		const { fetch, text } = await callListRepos({ "/search": "list-filter" }, { filter: "ALPHA" });

		expect(fetch.requests[0]?.searchParams.get("q")).toBe(
			loadCase("list-filter").request.query.q as string,
		);
		expect(text).toContain('1 repository match "ALPHA"');
		expect(text).toContain("example.test/alpha");
	});

	test("never sends type:repo", async () => {
		const { fetch } = await callListRepos({ "/search": "list-all" }, { filter: "x" });

		expect(fetch.requests[0]?.searchParams.get("q")).not.toContain("type:repo");
	});
});

describe("list_repos output", () => {
	test("golden: list-all", async () => {
		const { text } = await callListRepos({ "/search": "list-all" });

		expect(text).toBe(readFileSync(GOLDEN, "utf8"));
	});

	test("multi-branch alpha row shows branch@sha7; beta shows HEAD@", async () => {
		const { text } = await callListRepos({ "/search": "list-all" });
		const alpha = text.split("\n").find((l) => l.startsWith("example.test/alpha"));
		const beta = text.split("\n").find((l) => l.startsWith("example.test/beta"));

		expect(alpha).toMatch(/ main@[0-9a-f]{7}, main-old@[0-9a-f]{7}, feature@[0-9a-f]{7} /);
		expect(beta).toMatch(/ HEAD@[0-9a-f]{7} /);
	});

	test("more than 3 branches: HEAD first, then `+N more`", async () => {
		const branches = ["dev", "HEAD", "b2", "b3", "b4"].map((Name, i) => ({
			Name,
			Version: sha(String(i + 1)),
			URL: "",
		}));
		const { text } = await callListRepos({
			"/search": () =>
				Response.json({
					repos: {
						Stats: { Repos: 1 },
						Repos: [repoEntry("many/branches", { Branches: branches })],
					},
				}),
		});
		const row = text.split("\n").find((l) => l.startsWith("many/branches")) as string;

		expect(row).toContain(
			"HEAD@2222222, dev@1111111, b2@3333333, +2 more  3 files  2.0 KiB  indexed 2025-03-04",
		);
	});

	test("an empty listing (Repos: null) is not an error", async () => {
		const { result, text } = await callListRepos({
			"/search": () => Response.json({ repos: { Stats: { Repos: 0 }, Repos: null } }),
		});

		expect(result.isError).toBeFalsy();
		expect(text.startsWith("No repositories match")).toBe(true);
	});

	test("an empty listing under a filter quotes the filter", async () => {
		const { text } = await callListRepos(
			{ "/search": () => Response.json({ repos: { Repos: null } }) },
			{ filter: "zzz" },
		);

		expect(text).toBe(
			'No repositories match "zzz". Filters are regexes on the repository name, case-insensitive unless prefixed (?-i).',
		);
	});

	test("a Zoekt regexp error surfaces as a tool error", async () => {
		const { result, text } = await callListRepos(
			{
				"/search": () =>
					new Response("error parsing regexp: missing closing ): `(`\n", {
						status: 418,
						statusText: "I'm a teapot",
					}),
			},
			{ filter: "(" },
		);

		expect(result.isError).toBe(true);
		expect(text).toStartWith("list_repos error: Zoekt rejected the request: error parsing regexp");
	});
});

describe("list_repos paging", () => {
	const names = Array.from({ length: 6 }, (_, i) => `org/repo-${i + 1}`);

	test("{limit:2, offset:2} fetches num=4 and shows rows 3-4", async () => {
		const { fetch, text } = await callListRepos(
			{ "/search": stubRepos(names) },
			{ limit: 2, offset: 2 },
		);
		const rows = text.split("\n").filter((l) => l.startsWith("org/"));

		expect(fetch.requests[0]?.searchParams.get("num")).toBe("4");
		expect(rows.map((r) => r.split("  ")[0])).toEqual(["org/repo-3", "org/repo-4"]);
		expect(text).toContain("6 repositories indexed — showing 3-4.");
		expect(text).toContain(
			"Showing 3-4 of 6. Use offset=4 for the next page, or narrow the filter.",
		);
	});

	test("the last page has no footer", async () => {
		const { text } = await callListRepos({ "/search": stubRepos(names) }, { limit: 2, offset: 4 });

		expect(text).toContain("showing 5-6.");
		expect(text).not.toContain("Use offset=");
	});

	test("an offset past the end says so", async () => {
		const { result, text } = await callListRepos(
			{ "/search": stubRepos(names) },
			{ limit: 2, offset: 10 },
		);

		expect(result.isError).toBeFalsy();
		expect(text).toContain("offset=10 is past the end");
	});

	test.each([
		["limit 201", { limit: 201 }],
		["limit 0", { limit: 0 }],
		["offset -1", { offset: -1 }],
		["offset+limit > 5000", { limit: 200, offset: 4900 }],
		["filter over 500 chars", { filter: "x".repeat(501) }],
	])("%s is rejected without calling Zoekt", async (_label, args) => {
		const { result, fetch } = await callListRepos({ "/search": "list-all" }, args);

		expect(result.isError).toBe(true);
		expect(fetch.requests).toHaveLength(0);
	});

	test("offset+limit == 5000 is allowed", async () => {
		const { result, fetch } = await callListRepos(
			{ "/search": stubRepos(names) },
			{ limit: 200, offset: 4800 },
		);

		expect(result.isError).toBeFalsy();
		expect(fetch.requests[0]?.searchParams.get("num")).toBe("5000");
	});
});

describe("normalizeRepoList and formatting", () => {
	test("no nulls; zero IndexTime omitted; empty URL/metadata omitted", () => {
		const wire = RepoListWireSchema.parse(
			(loadCase("list-all").response.body as { repos: unknown }).repos,
		);
		const list = normalizeRepoList(wire, { limit: 50, offset: 0 });

		expect(list.total).toBe(3);
		expect(list.truncated).toBe(false);
		expect(list.repos[0]).toEqual({
			name: "example.test/alpha",
			branches: [
				{ name: "main", sha: "2f77c548bb76294591ff84b0195a1c742998a28a" },
				{ name: "main-old", sha: "3a2a361f90746fa7b565dbfd16210b88d017ee86" },
				{ name: "feature", sha: "115f341ddf85e8d64107abf59c8d990af1561af2" },
			],
			files: 13,
			sizeBytes: 448,
		});
		expect(JSON.stringify(list)).not.toContain("null");
	});

	test("Go's zero time is omitted; a real date is shown as YYYY-MM-DD", () => {
		const wire = RepoListWireSchema.parse({
			Repos: [
				repoEntry("zero", { IndexTime: "0001-01-01T00:00:00Z" }),
				repoEntry("real", { Metadata: { team: "x" } }),
			],
		});
		const list = normalizeRepoList(wire, { limit: 50, offset: 0 });

		expect(list.repos[0]).not.toHaveProperty("indexedAt");
		expect(list.repos[1]?.indexedAt).toBe("2025-03-04T05:06:07Z");
		expect(list.repos[1]?.metadata).toEqual({ team: "x" });
		expect(formatRepoList(list)).toContain(
			"real  HEAD@aaaaaaa  3 files  2.0 KiB  indexed 2025-03-04",
		);
	});

	test("formatBytes is base-1024", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(1023)).toBe("1023 B");
		expect(formatBytes(1024)).toBe("1.0 KiB");
		expect(formatBytes(1536)).toBe("1.5 KiB");
		expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
		expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GiB");
	});

	test("a filter is echoed in the header", () => {
		const list = normalizeRepoList(
			RepoListWireSchema.parse({ Stats: { Repos: 1 }, Repos: [repoEntry("a/b")] }),
			{ filter: "b", limit: 50, offset: 0 },
		);

		expect(formatRepoList(list).split("\n")[0]).toBe('1 repository match "b" — showing 1-1.');
	});
});

describe("redactUrl", () => {
	test("replaces userinfo", () => {
		expect(redactUrl("http://user:pass@zoekt:6070")).toBe("http://***:***@zoekt:6070");
		expect(redactUrl("http://token@zoekt:6070/")).toBe("http://***@zoekt:6070");
	});

	test("leaves credential-free URLs alone", () => {
		expect(redactUrl("http://zoekt:6070")).toBe("http://zoekt:6070");
	});
});

describe("cancellation through MCP", () => {
	test("cancelling a hanging call aborts the upstream Zoekt signal", async () => {
		let upstream: AbortSignal | undefined;
		let started: () => void = () => {};
		const hasStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const hanging = ((_url: unknown, init?: RequestInit) => {
			upstream = init?.signal ?? undefined;
			started();
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});
		}) as typeof fetch;

		mcp = await connectTestClient(testDeps(hanging));
		const controller = new AbortController();
		const call = mcp.client
			.callTool({ name: "list_repos", arguments: {} }, { signal: controller.signal })
			.catch((e: unknown) => e);
		await hasStarted;
		expect(upstream?.aborted).toBe(false);

		controller.abort();
		await call;
		for (let i = 0; i < 50 && !upstream?.aborted; i++) await Bun.sleep(10);

		expect(upstream?.aborted).toBe(true);
	});

	test("with a real socket: the hanging request is seen by fake-zoekt, then cancelled", async () => {
		const fake = await startFakeZoekt({ hang: true });
		try {
			mcp = await connectTestClient(testDeps(undefined, { baseUrl: fake.url }));
			const controller = new AbortController();
			const call = mcp.client
				.callTool({ name: "list_repos", arguments: {} }, { signal: controller.signal })
				.catch((e: unknown) => e);

			expect(await fake.nextRequest()).toBe("/search");
			controller.abort();
			await call;
		} finally {
			await fake.close();
		}
	});
});
