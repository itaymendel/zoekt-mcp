import { z } from "zod";

export const FragmentSchema = z.object({
	Pre: z.string(),
	Match: z.string(),
	Post: z.string(),
});

export const MatchSchema = z.object({
	URL: z.string(),
	FileName: z.string(),
	LineNum: z.number(),
	Fragments: z.array(FragmentSchema),
});

export const FileMatchSchema = z.object({
	FileName: z.string(),
	Repo: z.string(),
	ResultID: z.string().optional(),
	Language: z.string(),
	DuplicateID: z.string().optional(),
	Branches: z.array(z.string()).nullable(),
	Matches: z.array(MatchSchema).optional(),
	URL: z.string().optional(),
});

export const SearchStatsSchema = z.object({
	Duration: z.number(),
	FileCount: z.number(),
	MatchCount: z.number(),
	ContentBytesLoaded: z.number().optional(),
	IndexBytesLoaded: z.number().optional(),
	ShardsScanned: z.number().optional(),
});

export const SearchResponseSchema = z.object({
	result: z.object({
		FileMatches: z.array(FileMatchSchema).nullable().optional(),
		RepoURLs: z.record(z.string(), z.string()).optional(),
		Stats: SearchStatsSchema.optional(),
		QueryStr: z.string().optional(),
		Query: z.string().optional(),
	}),
});

export type Fragment = z.infer<typeof FragmentSchema>;
export type Match = z.infer<typeof MatchSchema>;
export type FileMatch = z.infer<typeof FileMatchSchema>;
export type SearchStats = z.infer<typeof SearchStatsSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export interface SearchOptions {
	query: string;
	num?: number;
	contextLines?: number;
}
