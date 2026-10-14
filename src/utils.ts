import type { RepoListWire } from "./zoekt/types.js";

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const MAX_BRANCHES_SHOWN = 3;

/** One line per repository, plus a header and (when paged) a footer. */
export function formatRepoList(
	wire: RepoListWire,
	{ filter, offset }: { filter?: string; offset: number },
): string {
	const repos = wire.Repos.slice(offset);
	const total = wire.Stats?.Repos || wire.Repos.length;
	if (repos.length === 0 && total === 0) {
		return filter
			? `No repositories match "${filter}". Filters are regexes on the repository name, case-insensitive unless prefixed (?-i).`
			: "No repositories match. Zoekt has no indexed repositories.";
	}
	const subject = `${total} ${plural(total, "repository", "repositories")} ${
		filter ? `match "${filter}"` : "indexed"
	}`;
	if (repos.length === 0) return `${subject}, but offset=${offset} is past the end.`;

	const first = offset + 1;
	const last = offset + repos.length;
	const parts = [`${subject} — showing ${first}-${last}.`, "", ...repos.map(formatRepoLine)];
	if (last < total) {
		parts.push(
			"",
			`Showing ${first}-${last} of ${total}. Use offset=${last} for the next page, or narrow the filter.`,
		);
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

export const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** Base-1024 size with one decimal above 1 KiB. */
export function formatBytes(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** The URL with any `user:password@` replaced by `***`, safe to log or show. */
export function redactUrl(url: string): string {
	let out = url;
	try {
		const u = new URL(url);
		if (u.username) u.username = "***";
		if (u.password) u.password = "***";
		out = u.href.replace(/\/$/, "");
	} catch {
		// unparsable: the pattern below still hides anything that looks like userinfo
	}
	// Defence for inputs URL parsing did not split (e.g. "u:secret@", "//u:secret@host").
	return out.replace(/(^|\/\/)(?!\*{3}[:@])[^/@\s]+@/, "$1***@");
}

/** `# <repo>`: the first line of search and read_file output. */
export const repoHeading = (repo: string) => `# ${repo}`;

/** `## <path>` plus an optional parenthesised or bracketed suffix, two spaces after the path. */
export const pathHeading = (path: string, suffix?: string) =>
	suffix ? `## ${path}  ${suffix}` : `## ${path}`;
