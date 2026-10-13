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
const dict = z
	.record(z.string(), z.string())
	.nullish()
	.transform((v) => v ?? {});

export const FragmentSchema = z.object({
	Pre: str,
	Match: str,
	Post: str,
});

export const MatchSchema = z.object({
	URL: str,
	FileName: str,
	LineNum: num,
	Fragments: list(FragmentSchema),
	/** Context lines before/after the match; only present when `ctx` > 0. */
	Before: str,
	After: str,
});

export const FileMatchSchema = z.object({
	FileName: z.string(),
	Repo: z.string(),
	ResultID: str,
	Language: str,
	DuplicateID: str,
	Branches: list(z.string()),
	Matches: list(MatchSchema),
	URL: str,
});

export const SearchStatsSchema = z.object({
	Duration: num,
	FileCount: num,
	MatchCount: num,
	FilesSkipped: num,
	ShardsSkipped: num,
	ContentBytesLoaded: num,
	IndexBytesLoaded: num,
	ShardsScanned: num,
	Crashes: num,
});

export const SearchResultSchema = z.object({
	FileMatches: list(FileMatchSchema),
	RepoURLs: dict,
	Stats: SearchStatsSchema.nullish().transform((v) => v ?? undefined),
	QueryStr: str,
	Query: str,
});

export const RepoBranchSchema = z.object({
	Name: z.string(),
	Version: str,
	URL: str,
});

export const RepoEntrySchema = z.object({
	Name: z.string(),
	URL: str,
	/** RFC 3339, or undefined when Zoekt reports "unknown" (Go zero time or the Unix epoch). */
	IndexTime: z
		.string()
		.nullish()
		.transform((v) => (v && new Date(v).getTime() > 0 ? v : undefined)),
	Branches: list(RepoBranchSchema),
	Files: num,
	Metadata: dict,
	Size: num,
	MemorySize: num,
});

export const RepoListStatsSchema = z.object({
	/** Total matching repositories, computed before `num` truncates `Repos`. */
	Repos: num,
	Shards: num,
	Documents: num,
	IndexBytes: num,
	ContentBytes: num,
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

export type Fragment = z.infer<typeof FragmentSchema>;
export type Match = z.infer<typeof MatchSchema>;
export type FileMatch = z.infer<typeof FileMatchSchema>;
export type SearchStats = z.infer<typeof SearchStatsSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type RepoListWire = z.infer<typeof RepoListWireSchema>;
export type ApiResponse = z.infer<typeof ApiResponseSchema>;
/** A `/search` answer known to be the `{result}` branch. */
export type SearchResponse = { result: SearchResult };

export interface SearchOptions {
	query: string;
	num?: number;
	contextLines?: number;
}

export interface ListReposOptions {
	num?: number;
}

/** Canonical repository listing returned by `ZoektClient.listRepos` consumers (no nulls). */
export interface RepoList {
	filter?: string;
	/** Total matching repositories (before paging). */
	total: number;
	offset: number;
	limit: number;
	/** More repositories exist beyond this page. */
	truncated: boolean;
	nextOffset?: number;
	repos: RepoInfo[];
}

export interface RepoInfo {
	name: string;
	url?: string;
	branches: Array<{ name: string; sha: string }>;
	files: number;
	sizeBytes: number;
	/** ISO timestamp; omitted when Zoekt reports a zero time. */
	indexedAt?: string;
	metadata?: Record<string, string>;
}
