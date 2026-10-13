import { z } from "zod";
import { clipLine, MAX_LINE_CHARS } from "../clip.js";
import { READ_ONLY_ANNOTATIONS } from "../instructions.js";
import {
	capSearch,
	DEFAULT_OUTPUT_CHARS,
	normalizeSearch,
	renderSearchText,
} from "../search-format.js";
import type { ZoektClient } from "../zoekt/client.js";
import { hasSymAtom } from "../zoekt/query.js";
import type { SearchModel } from "../zoekt/types.js";
import type { ToolContext, ToolResult } from "./result.js";

export const searchSchema = z.object({
	query: z.string().min(1).describe("Zoekt query; syntax is in the tool description"),
	maxFiles: z
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Maximum number of files to return (1-100)"),
	maxMatchesPerFile: z
		.number()
		.int()
		.min(1)
		.max(50)
		.default(5)
		.describe("Maximum matching lines shown per file (1-50); context lines are not counted"),
	contextLines: z
		.number()
		.int()
		.min(0)
		.max(10)
		.default(2)
		.describe("Number of context lines around each match (0-10)"),
});

export type SearchInput = z.infer<typeof searchSchema>;

export const searchMeta = { title: "Search code", annotations: READ_ONLY_ANNOTATIONS };

export const searchDescription = `Search code with Zoekt. Matches are grouped by repo and file with line numbers; pass the printed repo and path to read_file.

## Query syntax
- Every word is an unanchored RE2 regex, not a literal: \`a.b\` also matches aXb. A space means AND (within one file), lowercase \`or\` means OR, and parentheses group. \`and\` is not an operator; it is searched as text. \`X or Y r:z\` means \`X or (Y r:z)\`, so write \`(X or Y) r:z\`.
- Case is smart by default: all-lowercase terms ignore case, any capital makes the term case-sensitive. \`case:yes\` and \`case:no\` force it.
- A leading \`-\` negates a term or filter.
- Filters: \`r:\` or \`repo:\` (regex on the repo name, case-sensitive; use \`r:(?i)acme\`); \`f:\` or \`file:\` (regex on the path); \`lang:go\` (no short form; an unknown language matches nothing); \`b:\` or \`branch:\` (substring of the branch name; \`branch:HEAD\` is the default branch); \`c:\` (file content only); \`archived:\`, \`fork:\`, \`public:\` with yes or no; \`meta.<field>:\` (regex on repo metadata).
- \`sym:Name\` finds symbol definitions and tags each matching row with \`[kind name in parentKind parent]\`. It needs an index built with ctags; zero results may mean there are no symbols, so retry as plain text.
- \`type:file\` returns matching file paths only, no lines. Use it to find files by name.
- Quotes keep a phrase together. Inside quotes write \`\\\\.\` for a literal dot and \`\\"\` for a quote.

## Examples
- \`handleRequest\\( lang:go -f:_test\`
- \`sym:Server f:\\.ts$\`
- \`type:file f:docker-compose\`
- \`case:yes ErrNotFound\`
- \`(foo or bar) r:(?i)acme\`
- \`"v1\\\\.2" lang:go\`

## Output
Repos appear as \`# <repo>\` and files as \`## <path>\`. Rows are \`<line>:<text>\` for matches and \`<line>-<text>\` for context; \`--\` separates non-adjacent groups. For \`sym:\` queries a matching row ends with \`  [kind name]\` or \`  [kind name in parentKind parent]\`. Results are bounded by maxFiles, maxMatchesPerFile and an output size budget; the footer after \`---\` says what was cut. If it was cut, narrow the query with \`r:\`, \`f:\` or \`lang:\` instead of repeating it.`;

/** One displayed line of a hit. Extend this object to add per-line fields. */
const searchLineSchema = z.object({
	line: z.number().int().describe("1-based line number"),
	text: z
		.string()
		.describe(
			`Line text without the line ending; indentation kept, clipped to ${MAX_LINE_CHARS} characters around the first match, as in the text output. When the output budget cuts the first file, only the lines printed whole are listed`,
		),
	isMatch: z.boolean().describe("true for a matching line, false for a context line"),
	symbols: z
		.array(
			z.object({
				name: z.string().describe("Symbol name"),
				kind: z.string().describe("ctags kind, e.g. func, method, class"),
				parent: z.string().optional().describe("Enclosing symbol, e.g. demo.Server"),
				parentKind: z.string().optional().describe("ctags kind of the parent, e.g. struct"),
			}),
		)
		.optional()
		.describe(
			"Symbols defined on this line; only on match lines of sym: searches when Zoekt reports them. The text suffix shows the same data, capped at 120 characters",
		),
});

export const searchFileSchema = z.object({
	repo: z.string().describe("Repository name; pass as `repo` to read_file"),
	path: z.string().describe("File path within the repository; pass as `path` to read_file"),
	branches: z.array(z.string()).describe("Indexed branches that contain this file version"),
	filenameMatch: z.boolean().describe("The file path itself matched the query"),
	lines: z
		.array(searchLineSchema)
		.describe("Matching and context lines in ascending line order; empty for filename-only hits"),
	hiddenMatchLines: z
		.number()
		.int()
		.describe("Matching lines in this file omitted because of maxMatchesPerFile"),
});

export const searchOutputSchema = z.object({
	query: z.string().describe("The query as sent to Zoekt"),
	files: z.array(searchFileSchema).describe("Files shown, best match first, grouped as printed"),
	totalFiles: z.number().int().describe("Files that matched, including ones not shown"),
	totalFilesIsLowerBound: z
		.boolean()
		.describe("Zoekt skipped files or shards, so totalFiles is a lower bound"),
	totalMatches: z.number().int().describe("Matches reported by Zoekt"),
	truncated: z.boolean().describe("Something matched but is not in `files` or `lines`"),
	truncation: z.object({
		reasons: z
			.array(z.enum(["maxFiles", "maxMatchesPerFile", "outputBudget"]))
			.describe("Which bounds cut the result; empty when not truncated"),
		moreFiles: z.number().int().describe("Matched files beyond the maxFiles cap"),
		hiddenMatchLines: z
			.number()
			.int()
			.describe("Matching lines hidden by maxMatchesPerFile in the shown files"),
		filesOmittedByBudget: z
			.number()
			.int()
			.describe("Files dropped to stay within the output size budget"),
	}),
});

export type SearchOutput = z.infer<typeof searchOutputSchema>;

/** The public projection of the internal model: no rendered blocks, limits or offsets. */
function toSearchOutput(model: SearchModel): SearchOutput {
	const { totals, truncation } = model;
	return {
		query: model.query,
		files: model.files.map((f) => ({
			repo: f.repo,
			path: f.path,
			branches: f.branches,
			filenameMatch: f.filenameMatch,
			lines: f.lines.map((l) => ({
				line: l.n,
				text: clipLine(l.text, { focus: l.ranges?.[0] }),
				isMatch: l.match,
				...(l.symbols?.length ? { symbols: l.symbols } : {}),
			})),
			hiddenMatchLines: f.hiddenMatchLines,
		})),
		totalFiles: totals.files,
		totalFilesIsLowerBound: totals.filesIsLowerBound,
		totalMatches: totals.matches,
		truncated: model.truncated,
		truncation: {
			reasons: truncation.reasons,
			moreFiles: truncation.moreFiles,
			hiddenMatchLines: truncation.hiddenMatchLines,
			filesOmittedByBudget: truncation.filesOmittedByBudget,
		},
	};
}

export async function executeSearch(
	client: ZoektClient,
	input: SearchInput,
	ctx: ToolContext,
	{ maxChars = DEFAULT_OUTPUT_CHARS }: { maxChars?: number } = {},
): Promise<ToolResult<SearchOutput>> {
	const { query, maxFiles, maxMatchesPerFile, contextLines } = input;
	// Ask for one file more than shown, so Zoekt's own cap cannot hide that there were more.
	const response = await client.search(
		{ query, num: maxFiles + 1, contextLines, symbols: hasSymAtom(query) },
		{ signal: ctx.signal },
	);

	const model = capSearch(
		normalizeSearch(response, { query, contextLines, maxMatchesPerFile, maxFiles }),
		{ maxFiles, maxChars },
	);
	return {
		text: renderSearchText(model),
		structured: toSearchOutput(model),
		summary: { query, files: model.files.length, durationMs: model.durationMs },
	};
}
