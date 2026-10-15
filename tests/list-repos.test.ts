import { afterEach, describe, expect, test } from "bun:test";
import { formatRepoList } from "../src/tools/list-repos.js";
import { redactUrl } from "../src/utils.js";
import { RepoListWireSchema } from "../src/zoekt/types.js";
import { expectGolden } from "./helpers/golden.js";
import { hangingFetch } from "./helpers/hanging-fetch.js";
import { connectTestClient, resultText, type TestMcp } from "./helpers/mcp.js";
import { testDeps } from "./helpers/test-deps.js";
import { loadCase, mockZoektFetch } from "./helpers/zoekt-fixtures.js";

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

	test("list-filter replay: the request equals the captured case", async () => {
		const { fetch, text } = await callListRepos({ "/search": "list-filter" }, { filter: "ALPHA" });

		expect(fetch.requests[0]?.searchParams.get("q")).toBe(
			loadCase("list-filter").request.query.q as string,
		);
		expect(text).toContain('1 repository match "ALPHA"');
		expect(text).toContain("example.test/alpha");
	});
});

describe("list_repos output", () => {
	test("golden: list-all", async () => {
		const { text } = await callListRepos({ "/search": "list-all" });

		expectGolden("repos-all.txt", text);
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

	test("repo URLs with credentials and metadata never reach the result", async () => {
		const { result } = await callListRepos({
			"/search": () =>
				Response.json({
					repos: {
						Stats: { Repos: 1 },
						Repos: [
							repoEntry("org/r", {
								URL: "https://user:secret@example.test/r.git",
								Metadata: { token: "secret" },
								Branches: [
									{
										Name: "HEAD",
										Version: sha("a"),
										URL: "https://user:secret@example.test/r.git",
									},
								],
							}),
						],
					},
				}),
		});

		expect(JSON.stringify(result)).toContain("org/r");
		expect(JSON.stringify(result)).not.toContain("secret");
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

	test("offset+limit == 5000 is allowed", async () => {
		const { result, fetch } = await callListRepos(
			{ "/search": stubRepos(names) },
			{ limit: 200, offset: 4800 },
		);

		expect(result.isError).toBeFalsy();
		expect(fetch.requests[0]?.searchParams.get("num")).toBe("5000");
	});

	test("offset+limit > 5000 is rejected without calling Zoekt", async () => {
		const { result, text, fetch } = await callListRepos(
			{ "/search": stubRepos(names) },
			{ limit: 200, offset: 4801 },
		);

		expect(result.isError).toBe(true);
		expect(text).toContain("offset + limit must be at most 5000");
		expect(fetch.requests).toHaveLength(0);
	});
});

describe("formatRepoList", () => {
	test("Go's zero time is omitted and a real date shown as YYYY-MM-DD", () => {
		const wire = RepoListWireSchema.parse({
			Repos: [repoEntry("zero", { IndexTime: "0001-01-01T00:00:00Z" }), repoEntry("real")],
		});
		const lines = formatRepoList(wire, { offset: 0 }).split("\n");

		expect(lines).toContain("zero  HEAD@aaaaaaa  3 files  2.0 KiB");
		expect(lines).toContain("real  HEAD@aaaaaaa  3 files  2.0 KiB  indexed 2025-03-04");
	});

	test("a filter is echoed in the header", () => {
		const wire = RepoListWireSchema.parse({ Stats: { Repos: 1 }, Repos: [repoEntry("a/b")] });

		expect(formatRepoList(wire, { filter: "b", offset: 0 }).split("\n")[0]).toBe(
			'1 repository match "b" — showing 1-1.',
		);
	});
});

describe("redactUrl", () => {
	test("hides userinfo in non-http and unparsable inputs", () => {
		expect(redactUrl("ftp://u:s3cret@x")).not.toContain("s3cret");
		expect(redactUrl("u:s3cret@")).toBe("***@");
		expect(redactUrl("//u:s3cret@host")).toBe("//***@host");
		expect(redactUrl("not a url")).toBe("not a url");
	});

	test("leaves credential-free URLs alone", () => {
		expect(redactUrl("http://zoekt:6070")).toBe("http://zoekt:6070");
	});
});

describe("cancellation through MCP", () => {
	test("cancelling a hanging call aborts the upstream Zoekt signal", async () => {
		const hanging = hangingFetch();

		mcp = await connectTestClient(testDeps(hanging.fetch));
		const controller = new AbortController();
		const call = mcp.client
			.callTool({ name: "list_repos", arguments: {} }, { signal: controller.signal })
			.catch((e: unknown) => e);
		const upstream = await hanging.signalSeen;
		expect(upstream.aborted).toBe(false);

		controller.abort();
		await call;
		await hanging.aborted;

		expect(upstream.aborted).toBe(true);
	});
});
