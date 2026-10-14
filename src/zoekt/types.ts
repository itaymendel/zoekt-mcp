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
	Duration: num,
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
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type RepoListWire = z.infer<typeof RepoListWireSchema>;

/**
 * `POST /api/search` (`zoekt-webserver -rpc`) answer, reduced to what symbol enrichment reads.
 * `SymbolInfo` runs parallel to `Ranges` and may hold nulls (ranges that are not a symbol).
 */
export const ApiSearchResponseSchema = z.object({
	Result: z.object({
		Files: list(
			z.object({
				FileName: z.string(),
				Repository: z.string(),
				ChunkMatches: list(
					z.object({
						ContentStart: z.object({ LineNumber: num }).nullish(),
						Ranges: list(z.object({ Start: z.object({ LineNumber: num }) })),
						SymbolInfo: z
							.array(z.object({ Sym: str, Kind: str, Parent: str, ParentKind: str }).nullable())
							.nullish()
							.transform((v) => v ?? []),
					}),
				),
			}),
		),
	}),
});

export type ApiSearchResponse = z.infer<typeof ApiSearchResponseSchema>;

/** A ctags symbol defined on a matching line. */
export interface SearchSymbol {
	name: string;
	kind: string;
	/** Enclosing symbol (e.g. `demo.Server`); omitted at top level. */
	parent?: string;
	parentKind?: string;
}

/** Symbols per match line, keyed by `symbolKey(repo, file, line)`. */
export type SymbolIndex = Map<string, SearchSymbol[]>;

export const symbolKey = (repo: string, file: string, line: number) => `${repo}\0${file}\0${line}`;

/** A `/search` answer known to be the `{result}` branch. */
export type SearchResponse = {
	result: SearchResult;
	/** Present only when symbol enrichment was requested and `/api/search` answered. */
	symbols?: SymbolIndex;
};

export interface SearchOptions {
	query: string;
	num?: number;
	contextLines?: number;
	/** Also ask `/api/search` for ctags symbols of the matching lines (best effort). */
	symbols?: boolean;
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
	/** More repositories exist beyond this page. */
	truncated: boolean;
	nextOffset?: number;
	repos: RepoInfo[];
}

export interface RepoInfo {
	name: string;
	branches: Array<{ name: string; sha: string }>;
	files: number;
	sizeBytes: number;
	/** ISO timestamp; omitted when Zoekt reports a zero time. */
	indexedAt?: string;
}
