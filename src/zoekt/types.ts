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
/** A `/search` answer known to be the `{result}` branch. */
export type SearchResponse = { result: SearchResult };

export interface SearchOptions {
	query: string;
	num?: number;
	contextLines?: number;
}

/** A displayed line of a search hit: a matching line (`match`) or a context line. */
export interface SearchLine {
	/** 1-based line number. */
	n: number;
	/** Line text without the trailing newline; indentation preserved. */
	text: string;
	match: boolean;
	/** `[start, end)` offsets of the matched fragments within `text` (match lines only). */
	ranges?: Array<[number, number]>;
}

export interface SearchFile {
	repo: string;
	path: string;
	branches: string[];
	/** The file's path itself matched (Zoekt reports LineNum 0). */
	filenameMatch: boolean;
	/** Matching lines plus context lines, sorted by `n`. */
	lines: SearchLine[];
	/** Matching lines dropped by `maxMatchesPerFile` and not shown as context either. */
	hiddenMatchLines: number;
}

type TruncationReason = "maxFiles" | "maxMatchesPerFile" | "outputBudget";

/** Normalized, bounded view of a Zoekt search answer; what the text renderer consumes. */
export interface SearchModel {
	query: string;
	files: SearchFile[];
	totals: {
		/** Zoekt's `FileCount`: files matched before the `num` cap. */
		files: number;
		/** Zoekt skipped files or shards, so `files` is a lower bound. */
		filesIsLowerBound: boolean;
		matches: number;
	};
	truncated: boolean;
	truncation: {
		reasons: TruncationReason[];
		/** Matched files beyond the ones in `files` because of `maxFiles`. */
		moreFiles: number;
		/** Matching lines hidden by `maxMatchesPerFile` in the shown files. */
		hiddenMatchLines: number;
		filesOmittedByBudget: number;
	};
	durationMs: number;
	/** The bounds this model was built under; the footer names them. */
	limits: { maxFiles: number; maxMatchesPerFile: number; maxChars: number };
	/** Final text of each entry of `files` (same order), filled in by `capSearch`. */
	blocks: string[];
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
	branches: Array<{ name: string; sha: string }>;
	files: number;
	sizeBytes: number;
	/** ISO timestamp; omitted when Zoekt reports a zero time. */
	indexedAt?: string;
}

/** Canonical shape of a `read_file` answer: a bounded, line-numbered window of one file. */
export interface FileContent {
	repo: string;
	path: string;
	branch?: string;
	/** First line returned (1-based); equals the requested start. */
	startLine: number;
	/** Last line actually returned; `startLine - 1` when no line is returned. */
	endLine: number;
	/** Lines in the file; a lower bound when the fetch was cut at the byte cap. */
	totalLines: number;
	totalLinesIsLowerBound: boolean;
	/** Returned lines in ascending order (CRLF stripped, long lines clipped). */
	lines: Array<{ line: number; text: string }>;
	truncated: boolean;
	truncationReason?: "window" | "chars" | "fetchCap";
	/** Where to continue when the window was cut and more lines are readable. */
	nextStartLine?: number;
}
