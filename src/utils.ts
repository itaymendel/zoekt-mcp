import type { RepoInfo, RepoList } from "./zoekt/types.js";

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const MAX_BRANCHES_SHOWN = 3;

/** One line per repository, plus a header and (when paged) a footer. */
export function formatRepoList(list: RepoList): string {
	const { filter, total, offset, repos } = list;
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
	const header = `${subject} — showing ${first}-${last}.`;
	const lines = repos.map(formatRepoLine);
	const parts = [header, "", ...lines];
	if (list.truncated) {
		parts.push(
			"",
			`Showing ${first}-${last} of ${total}. Use offset=${list.nextOffset ?? last} for the next page, or narrow the filter.`,
		);
	}
	return parts.join("\n");
}

function formatRepoLine(repo: RepoInfo): string {
	const head: RepoInfo["branches"] = [];
	const rest: RepoInfo["branches"] = [];
	for (const b of repo.branches) (b.name === "HEAD" ? head : rest).push(b);
	const ordered = [...head, ...rest];
	const shown = ordered.slice(0, MAX_BRANCHES_SHOWN).map((b) => `${b.name}@${b.sha.slice(0, 7)}`);
	const extra = ordered.length - shown.length;
	if (extra > 0) shown.push(`+${extra} more`);

	return [
		repo.name,
		shown.join(", "),
		`${repo.files} ${plural(repo.files, "file", "files")}`,
		formatBytes(repo.sizeBytes),
		repo.indexedAt ? `indexed ${repo.indexedAt.slice(0, 10)}` : "",
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

export function formatFileContentAsText(
	repository: string,
	filePath: string,
	content: string,
	branch?: string,
): string {
	const lineCount = content.split("\n").length;
	const basePath = `${repository}/${filePath}`;
	const location = branch ? `${basePath} (branch: ${branch})` : basePath;

	return `File: ${location}\nLines: ${lineCount}\n\n${content}`;
}
