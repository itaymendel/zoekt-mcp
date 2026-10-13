import { z } from "zod";
import { formatRepoList } from "../utils.js";
import type { ZoektClient } from "../zoekt/client.js";
import { repoListQuery } from "../zoekt/query.js";
import type { RepoList, RepoListWire } from "../zoekt/types.js";
import type { ToolContext, ToolResult } from "./result.js";

/** Zoekt has no offset, so a page is fetched as the first `offset + limit` repos and sliced. */
const MAX_WINDOW = 5000;

export const listReposSchema = z.object({
	filter: z
		.string()
		.max(500)
		.optional()
		.describe(
			"Regex on the repository name; unanchored and case-insensitive. Prefix with (?-i) for case-sensitive.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(200)
		.default(50)
		.describe("Maximum repositories to return (1-200)"),
	offset: z.number().int().min(0).default(0).describe("Repositories to skip, for paging"),
});

export type ListReposInput = z.infer<typeof listReposSchema>;

export const listReposDescription = `List indexed repositories, one line per repository: name, branches (branch@sha), file count, size and index date.

\`filter\` is an unanchored, case-insensitive regex on the repository name (prefix it with \`(?-i)\` for case-sensitive). Results are sorted by name; use \`limit\` and \`offset\` to page.

### Examples
- List all repos: \`{}\`
- Filter by org: \`{ "filter": "^github\\\\.com/myorg/" }\`
- Filter by name: \`{ "filter": "api" }\`
- Next page: \`{ "limit": 50, "offset": 50 }\``;

export function normalizeRepoList(
	wire: RepoListWire,
	{ filter, limit, offset }: { filter?: string; limit: number; offset: number },
): RepoList {
	const page = wire.Repos.slice(offset);
	const total = wire.Stats?.Repos || wire.Repos.length;
	const end = offset + page.length;
	const truncated = end < total;
	return {
		...(filter ? { filter } : {}),
		total,
		offset,
		limit,
		truncated,
		...(truncated ? { nextOffset: end } : {}),
		repos: page.map((r) => {
			const indexed = r.IndexTime ? new Date(r.IndexTime) : undefined;
			return {
				name: r.Name,
				...(r.URL ? { url: r.URL } : {}),
				branches: r.Branches.map((b) => ({ name: b.Name, sha: b.Version })),
				files: r.Files,
				sizeBytes: r.Size,
				// Go's zero time (0001-01-01) and the Unix epoch both mean "unknown".
				...(indexed && indexed.getTime() > 0 ? { indexedAt: r.IndexTime } : {}),
				...(Object.keys(r.Metadata).length ? { metadata: r.Metadata } : {}),
			};
		}),
	};
}

export async function executeListRepos(
	client: ZoektClient,
	input: ListReposInput,
	ctx: ToolContext,
): Promise<ToolResult<RepoList>> {
	const { filter, limit, offset } = input;
	if (offset + limit > MAX_WINDOW) {
		throw new Error(
			`offset + limit must be at most ${MAX_WINDOW} (got ${offset + limit}); narrow the filter instead of paging that deep.`,
		);
	}
	const wire = await client.listRepos(
		repoListQuery(filter),
		{ num: offset + limit, order: "name" },
		{ signal: ctx.signal },
	);
	const data = normalizeRepoList(wire, { filter, limit, offset });
	return { text: formatRepoList(data), data };
}
