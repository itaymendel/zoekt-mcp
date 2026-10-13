import { z } from "zod";
import {
	capSearch,
	DEFAULT_OUTPUT_CHARS,
	normalizeSearch,
	renderSearchText,
} from "../search-format.js";
import type { ZoektClient } from "../zoekt/client.js";
import type { SearchModel } from "../zoekt/types.js";
import type { ToolContext, ToolResult } from "./result.js";

export const searchSchema = z.object({
	query: z.string().min(1).describe("Zoekt search query"),
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

export const searchDescription = `Search code using Zoekt.

## Query Syntax

### Basic Search
- \`foo\` - Search for "foo" in file contents
- \`"hello world"\` - Search for exact phrase
- \`foo bar\` - Search for files containing both "foo" AND "bar"
- \`foo or bar\` - Search for files containing "foo" OR "bar"

### File Filters
- \`file:path/to/file\` - Match file path (supports regex)
- \`file:\\.ts$\` - Files ending in .ts
- \`-file:test\` - Exclude files matching "test"
- \`lang:typescript\` - Files of specific language
- \`lang:go\` - Go files

### Repository Filters
- \`repo:myrepo\` - Search in specific repository
- \`repo:github.com/org/.*\` - Regex match on repo name
- \`-repo:vendor\` - Exclude repositories matching "vendor"

### Branch Filters
- \`branch:main\` - Search only in main branch
- \`branch:feature-.*\` - Regex match on branch name

### Symbol Search
- \`sym:functionName\` - Search for symbol definitions
- \`sym:MyClass\` - Find class/type definitions

### Special Queries
- \`case:yes\` - Case-sensitive search (default is case-insensitive)
- \`content:pattern\` - Explicitly search file content

### Regular Expressions
- \`foo.*bar\` - Regex: foo followed by anything then bar
- \`\\bword\\b\` - Word boundary match
- \`[A-Z][a-z]+\` - Capitalized words

### Examples
- \`func.*Error lang:go\` - Go functions with "Error" in name
- \`TODO repo:myproject -file:vendor\` - TODOs excluding vendor
- \`import.*react file:\\.tsx$\` - React imports in TSX files
- \`sym:handleRequest lang:typescript\` - TypeScript function named handleRequest

## Output format
Results are grouped as \`# <repo>\` then \`## <path>\` (pass both to file_content). Rows are \`<line>:<text>\` for matches and \`<line>-<text>\` for context; \`--\` separates non-adjacent groups. Branches are listed only when they differ between files. A footer after \`---\` gives the totals, or says what was truncated (maxFiles, maxMatchesPerFile, output size).`;

export async function executeSearch(
	client: ZoektClient,
	input: SearchInput,
	ctx: ToolContext,
	{ maxChars = DEFAULT_OUTPUT_CHARS }: { maxChars?: number } = {},
): Promise<ToolResult<SearchModel>> {
	const { query, maxFiles, maxMatchesPerFile, contextLines } = input;
	// Ask for one file more than shown, so Zoekt's own cap cannot hide that there were more.
	const response = await client.search(
		{ query, num: maxFiles + 1, contextLines },
		{ signal: ctx.signal },
	);

	const model = capSearch(normalizeSearch(response, { query, contextLines, maxMatchesPerFile }), {
		maxFiles,
		maxChars,
	});
	ctx.logger?.debug(
		{ query, files: model.files.length, durationMs: model.durationMs },
		"search finished",
	);
	return { text: renderSearchText(model, { maxChars, maxMatchesPerFile }), data: model };
}
