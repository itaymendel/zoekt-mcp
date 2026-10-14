import { z } from "zod";

// Zoekt is Go: nil slices/maps marshal as `null` and zero values may be omitted, so every array,
// string and number below tolerates null/missing and normalizes to an empty value.
const list = <T extends z.ZodType>(s: T) =>
	z
		.array(s)
		.nullish()
		.transform((v) => v ?? []);
const str = z
	.string()
	.nullish()
	.transform((v) => v ?? "");
const num = z
	.number()
	.nullish()
	.transform((v) => v ?? 0);

const FragmentSchema = z.object({
	Pre: str,
	Match: str,
	Post: str,
});

const MatchSchema = z.object({
	LineNum: num,
	Fragments: list(FragmentSchema),
	/** Context lines before/after the match; only present when `ctx` > 0. */
	Before: str,
	After: str,
});

const FileMatchSchema = z.object({
	FileName: z.string(),
	Repo: z.string(),
	Branches: list(z.string()),
	Matches: list(MatchSchema),
});

const SearchStatsSchema = z.object({
	FileCount: num,
	MatchCount: num,
	FilesSkipped: num,
	ShardsSkipped: num,
});

export const SearchResultSchema = z.object({
	FileMatches: list(FileMatchSchema),
	Stats: SearchStatsSchema.nullish().transform((v) => v ?? undefined),
});

const RepoBranchSchema = z.object({
	Name: z.string(),
	Version: str,
});

const RepoEntrySchema = z.object({
	Name: z.string(),
	/** RFC 3339, or undefined when Zoekt reports "unknown" (Go zero time or the Unix epoch). */
	IndexTime: z
		.string()
		.nullish()
		.transform((v) => (v && new Date(v).getTime() > 0 ? v : undefined)),
	Branches: list(RepoBranchSchema),
	Files: num,
	Size: num,
});

const RepoListStatsSchema = z.object({
	/** Total matching repositories, computed before `num` truncates `Repos`. */
	Repos: num,
});

export const RepoListWireSchema = z.object({
	Stats: RepoListStatsSchema.nullish().transform((v) => v ?? undefined),
	Repos: list(RepoEntrySchema),
});

/** Repo-only queries (`r:`) answer `{repos}`; everything else answers `{result}`. */
export const ApiResponseSchema = z
	.object({
		result: SearchResultSchema.nullish(),
		repos: RepoListWireSchema.nullish(),
	})
	.refine((v) => v.result != null || v.repos != null, {
		message: "neither 'result' nor 'repos' present",
	});

export type Match = z.infer<typeof MatchSchema>;
export type FileMatch = z.infer<typeof FileMatchSchema>;
type SearchResult = z.infer<typeof SearchResultSchema>;
export type RepoListWire = z.infer<typeof RepoListWireSchema>;

/** A `/search` answer known to be the `{result}` branch. */
export type SearchResponse = { result: SearchResult };

export interface SearchOptions {
	query: string;
	num?: number;
	contextLines?: number;
}
