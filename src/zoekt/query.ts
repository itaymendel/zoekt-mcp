/** The only place that builds Zoekt query text. */

const REGEX_SPECIALS = /[\\.+*?()|[\]{}^$]/g;

/** Escapes every regex metacharacter (`\ . + * ? ( ) | [ ] { } ^ $`) so `s` matches literally. */
export function escapeRegex(s: string): string {
	return s.replace(REGEX_SPECIALS, "\\$&");
}

/** Wraps `s` in double quotes for a Zoekt query, escaping `\` and `"`. */
export function quoteArg(s: string): string {
	return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

/** Atom matching exactly one repository name. */
export function exactRepoAtom(name: string): string {
	return `r:${quoteArg(`^${escapeRegex(name)}$`)}`;
}

/**
 * Repo-only query for list_repos. Unset/empty -> every repo. Zoekt's repo regex is case-sensitive
 * even under `case:auto`, so a plain filter gets `(?i)`; a filter starting with `(?` (flags such as
 * `(?-i)`) is passed through verbatim. Never uses the `type:` atom for repos (it means "repos with a content match").
 */
export function repoListQuery(filter?: string): string {
	if (!filter) return `r:${quoteArg(".")}`;
	return `r:${quoteArg(filter.startsWith("(?") ? filter : `(?i)${filter}`)}`;
}

/**
 * True when the query has a positive `sym:` atom, i.e. one worth enriching with symbol info.
 * Heuristic, case-insensitive: `sym:` must start a word (query start, after whitespace or `(`),
 * so `-sym:x` (negated) and `foo-sym:` do not count; double-quoted text (with `\\` escapes)
 * is skipped. A false positive only costs one extra request and a false negative only the suffix.
 */
export function hasSymAtom(query: string): boolean {
	let quoted = false;
	for (let i = 0; i < query.length; i++) {
		const c = query[i];
		if (quoted) {
			if (c === "\\") i++;
			else if (c === '"') quoted = false;
		} else if (c === '"') {
			quoted = true;
		} else if (
			(i === 0 || /[\s(]/.test(query[i - 1] ?? "")) &&
			query.slice(i, i + 4).toLowerCase() === "sym:"
		) {
			return true;
		}
	}
	return false;
}
