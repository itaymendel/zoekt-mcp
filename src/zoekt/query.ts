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
