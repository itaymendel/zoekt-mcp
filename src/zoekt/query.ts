/** The only place that builds Zoekt query text. */

/** Leading regex flag group: `(?i)`, `(?-i)`, `(?s-i:`. */
const FLAG_GROUP = /^\(\?[a-zA-Z-]+[:)]/;

const REGEX_SPECIALS = /[\\.+*?()|[\]{}^$]/g;

/** Escapes every regex metacharacter (`\ . + * ? ( ) | [ ] { } ^ $`) so `s` matches literally. */
function escapeRegex(s: string): string {
	return s.replace(REGEX_SPECIALS, "\\$&");
}

/** Wraps `s` in double quotes for a Zoekt query, escaping `\` and `"`. */
function quoteArg(s: string): string {
	return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

/** Atom matching exactly one repository name. */
export function exactRepoAtom(name: string): string {
	return `r:${quoteArg(`^${escapeRegex(name)}$`)}`;
}

/**
 * Repo-only query for list_repos. Unset/empty -> every repo. Zoekt's repo regex is case-sensitive
 * even under `case:auto`, so a plain filter gets `(?i)`. A filter that starts with a flag group, `(?-i)`
 * or `(?i:...)`, controls its own case and is passed through verbatim; a non-capturing group
 * `(?:...)` or named group `(?P<n>...)` is not a flag group and still gets `(?i)`.
 * Never uses the `type:` atom for repos (it means "repos with a content match").
 */
export function repoListQuery(filter?: string): string {
	if (!filter) return `r:${quoteArg(".")}`;
	return `r:${quoteArg(FLAG_GROUP.test(filter) ? filter : `(?i)${filter}`)}`;
}
