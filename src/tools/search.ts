import { z } from "zod";
import { formatSearchResultsAsText } from "../utils.js";
import type { ZoektClient } from "../zoekt/client.js";
import type { ToolContext } from "./result.js";

export const searchSchema = z.object({
	query: z.string().describe("Zoekt search query"),
	limit: z.number().int().min(1).max(100).default(30).describe("Maximum number of results (1-100)"),
	contextLines: z
		.number()
		.int()
		.min(0)
		.max(10)
		.default(3)
		.describe("Number of context lines around matches (0-10)"),
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
- \`type:repo\` - List repositories instead of searching content
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
- \`sym:handleRequest lang:typescript\` - TypeScript function named handleRequest`;

export async function executeSearch(
	client: ZoektClient,
	input: SearchInput,
	ctx: ToolContext,
): Promise<string> {
	const response = await client.search(
		{ query: input.query, num: input.limit, contextLines: input.contextLines },
		{ signal: ctx.signal },
	);

	const result = formatSearchResultsAsText(response);
	const stats = response.result.Stats;

	if (!stats) return result;

	return `${result}\n---\nStats: ${stats.MatchCount} matches in ${stats.FileCount} files (${stats.Duration / 1000}ms)`;
}
