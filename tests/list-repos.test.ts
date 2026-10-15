import { afterEach, describe, expect, test } from "bun:test";
import { formatRepoList } from "../src/tools/list-repos.js";
import { redactUrl } from "../src/utils.js";
import { RepoListWireSchema } from "../src/zoekt/types.js";
import { expectGolden } from "./helpers/golden.js";
import { hangingFetch } from "./helpers/hanging-fetch.js";
import { connectTestClient, resultText, type TestMcp } from "./helpers/mcp.js";
import { testDeps } from "./helpers/test-deps.js";
import { mockZoektFetch } from "./helpers/zoekt-fixtures.js";

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
		expect(params?.get("q")).toBe('r:"."');
		expect(params?.get("num")).toBe("50");
		expect(params?.get("order")).toBe("name");
		expect(params?.get("format")).toBe("json");
		expect(text.startsWith("3 repositories indexed")).toBe(true);
	});

	test("a filter becomes a case-insensitive repo query", async () => {
		const { fetch, text } = await callListRepos({ "/search": "list-filter" }, { filter: "ALPHA" });

		expect(fetch.requests[0]?.searchParams.get("q")).toBe('r:"(?i)ALPHA"');
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

		expect(row).toContain("many/branches  HEAD@2222222, dev@1111111, b2@3333333, +2 more");
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

describe("list_repos limit", () => {
	const names = Array.from({ length: 6 }, (_, i) => `org/repo-${i + 1}`);

	test("a list cut at limit says so and points at filter", async () => {
		const { fetch, text } = await callListRepos({ "/search": stubRepos(names) }, { limit: 2 });
		const rows = text.split("\n").filter((l) => l.startsWith("org/"));

		expect(fetch.requests[0]?.searchParams.get("num")).toBe("2");
		expect(rows.map((r) => r.split("  ")[0])).toEqual(["org/repo-1", "org/repo-2"]);
		expect(text).toContain("6 repositories indexed.");
		expect(text).toEndWith("Showing 2 of 6. Narrow with `filter`.");
	});

	test("a complete list has no footer", async () => {
		const { text } = await callListRepos({ "/search": stubRepos(names) }, { limit: 6 });

		expect(text).not.toContain("Narrow with");
	});
});

describe("formatRepoList", () => {
	test("a line is the name and its branches", () => {
		const wire = RepoListWireSchema.parse({ Repos: [repoEntry("real")] });

		expect(formatRepoList(wire, {}).split("\n")).toContain("real  HEAD@aaaaaaa");
	});

	test("a filter is echoed in the header", () => {
		const wire = RepoListWireSchema.parse({ Stats: { Repos: 1 }, Repos: [repoEntry("a/b")] });

		expect(formatRepoList(wire, { filter: "b" }).split("\n")[0]).toBe('1 repository match "b".');
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
