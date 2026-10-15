export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

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
