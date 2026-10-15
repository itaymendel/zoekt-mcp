import { z } from "zod";
import { plural } from "../utils.js";
import { repoListQuery } from "../zoekt/query.js";
import type { RepoListWire } from "../zoekt/types.js";
import type { Tool } from "./tool.js";

const inputSchema = z.object({
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
});

const description = `List indexed repositories, one line each: name, branches (branch@sha), file count, size and index date. Sorted by name.

\`filter\` is an unanchored regex on the repository name, case-insensitive by default (start it with \`(?-i)\` for case-sensitive).

Use the exact names as \`repo\` in read_file and as \`r:"^name$"\` in search.

### Examples
- \`{}\`
- \`{ "filter": "^github\\\\.com/myorg/" }\`
- \`{ "limit": 100 }\``;

const MAX_BRANCHES_SHOWN = 3;

/** One line per repository, plus a header and (when cut at `limit`) a footer. */
export function formatRepoList(wire: RepoListWire, { filter }: { filter?: string }): string {
	const repos = wire.Repos;
	const total = wire.Stats?.Repos || repos.length;
	if (repos.length === 0) {
		return filter
			? `No repositories match "${filter}". Filters are regexes on the repository name, case-insensitive unless prefixed (?-i).`
			: "No repositories match. Zoekt has no indexed repositories.";
	}
	const subject = `${total} ${plural(total, "repository", "repositories")} ${
		filter ? `match "${filter}"` : "indexed"
	}`;
	const parts = [`${subject}.`, "", ...repos.map(formatRepoLine)];
	if (repos.length < total) {
		parts.push("", `Showing ${repos.length} of ${total}. Narrow with \`filter\`.`);
	}
	return parts.join("\n");
}

function formatRepoLine(repo: RepoListWire["Repos"][number]): string {
	const head: typeof repo.Branches = [];
	const rest: typeof repo.Branches = [];
	for (const b of repo.Branches) (b.Name === "HEAD" ? head : rest).push(b);
	const ordered = [...head, ...rest];
	const shown = ordered
		.slice(0, MAX_BRANCHES_SHOWN)
		.map((b) => `${b.Name}@${b.Version.slice(0, 7)}`);
	const extra = ordered.length - shown.length;
	if (extra > 0) shown.push(`+${extra} more`);

	return [
		repo.Name,
		shown.join(", "),
		`${repo.Files} ${plural(repo.Files, "file", "files")}`,
		formatBytes(repo.Size),
		repo.IndexTime ? `indexed ${repo.IndexTime.slice(0, 10)}` : "",
	]
		.filter(Boolean)
		.join("  ");
}

/** Base-1024 size with one decimal above 1 KiB. */
function formatBytes(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export const listReposTool: Tool<typeof inputSchema> = {
	name: "list_repos",
	title: "List indexed repositories",
	description,
	inputSchema,
	async execute(client, { filter, limit }, ctx) {
		const wire = await client.listRepos(repoListQuery(filter), limit, { signal: ctx.signal });
		return formatRepoList(wire, { filter });
	},
};
