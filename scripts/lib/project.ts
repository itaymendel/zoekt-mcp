/** Keeps only the fields `src/zoekt/types.ts` reads, so fixtures stay small and diffs stay quiet. */

const pick = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
	const src = (value ?? {}) as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of keys) if (key in src) out[key] = src[key];
	return out;
};

const each = (value: unknown, fn: (item: unknown) => unknown) =>
	Array.isArray(value) ? value.map(fn) : value;

const projectMatch = (m: unknown) => {
	const out = pick(m, ["LineNum", "Fragments", "Before", "After"]);
	out.Fragments = each(out.Fragments, (f) => pick(f, ["Pre", "Match", "Post"]));
	return out;
};

const projectFileMatch = (f: unknown) => {
	const out = pick(f, ["FileName", "Repo", "Branches", "Matches"]);
	out.Matches = each(out.Matches, projectMatch);
	return out;
};

const projectRepo = (r: unknown) => {
	const out = pick(r, ["Name", "IndexTime", "Branches", "Files", "Size"]);
	out.Branches = each(out.Branches, (b) => pick(b, ["Name", "Version"]));
	return out;
};

/** A captured `/search` JSON body reduced to the fields the schemas read; anything else passes through. */
export function projectBody(body: unknown): unknown {
	const { result, repos } = (body ?? {}) as { result?: unknown; repos?: unknown };
	if (result !== undefined && result !== null) {
		const out = pick(result, ["Stats", "FileMatches"]);
		if (out.Stats != null)
			out.Stats = pick(out.Stats, ["FileCount", "MatchCount", "FilesSkipped", "ShardsSkipped"]);
		out.FileMatches = each(out.FileMatches, projectFileMatch);
		return { result: out };
	}
	if (repos !== undefined && repos !== null) {
		const out = pick(repos, ["Stats", "Repos"]);
		if (out.Stats != null) out.Stats = pick(out.Stats, ["Repos"]);
		out.Repos = each(out.Repos, projectRepo);
		return { repos: out };
	}
	return body;
}
