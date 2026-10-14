import { z } from "zod";
import { READ_ONLY_ANNOTATIONS } from "../instructions.js";
import { formatRepoList } from "../utils.js";
import type { ZoektClient } from "../zoekt/client.js";
import { repoListQuery } from "../zoekt/query.js";
import type { RepoList, RepoListWire } from "../zoekt/types.js";

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

export const listReposMeta = {
	title: "List indexed repositories",
	annotations: READ_ONLY_ANNOTATIONS,
};

export const listReposDescription = `List indexed repositories, one line each: name, branches (branch@sha), file count, size and index date. Sorted by name.

\`filter\` is an unanchored regex on the repository name, case-insensitive by default (start it with \`(?-i)\` for case-sensitive). Page with \`limit\` and \`offset\`.

Use the exact names as \`repo\` in read_file and as \`r:"^name$"\` in search.

### Examples
- \`{}\`
- \`{ "filter": "^github\\\\.com/myorg/" }\`
- \`{ "limit": 50, "offset": 50 }\``;

export function normalizeRepoList(
	wire: RepoListWire,
	{ filter, offset }: { filter?: string; offset: number },
): RepoList {
	const page = wire.Repos.slice(offset);
	const total = wire.Stats?.Repos || wire.Repos.length;
	const end = offset + page.length;
	const truncated = end < total;
	return {
		filter,
		total,
		offset,
		truncated,
		nextOffset: truncated ? end : undefined,
		repos: page.map((r) => ({
			name: r.Name,
			branches: r.Branches.map((b) => ({ name: b.Name, sha: b.Version })),
			files: r.Files,
			sizeBytes: r.Size,
			indexedAt: r.IndexTime,
		})),
	};
}

export async function executeListRepos(
	client: ZoektClient,
	input: ListReposInput,
	ctx: { signal: AbortSignal },
): Promise<string> {
	const { filter, limit, offset } = input;
	if (offset + limit > MAX_WINDOW) {
		throw new Error(
			`offset + limit must be at most ${MAX_WINDOW} (got ${offset + limit}); narrow the filter instead of paging that deep.`,
		);
	}
	const wire = await client.listRepos(repoListQuery(filter), offset + limit, {
		signal: ctx.signal,
	});
	const data = normalizeRepoList(wire, { filter, offset });
	return formatRepoList(data);
}
