import { z } from "zod";
import { READ_ONLY_ANNOTATIONS } from "../instructions.js";
import { DEFAULT_OUTPUT_CHARS, formatSearch } from "../search-format.js";
import type { Tool } from "./tool.js";

const inputSchema = z.object({
	query: z.string().min(1).describe("Zoekt query; syntax is in the tool description"),
	maxFiles: z
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Maximum number of files to return (1-100)"),
	contextLines: z
		.number()
		.int()
		.min(0)
		.max(10)
		.default(2)
		.describe("Number of context lines around each match (0-10)"),
});

const description = `Search code with Zoekt. Matches are grouped by repo and file with line numbers; pass the printed repo and path to read_file.

## Query syntax
- Every word is an unanchored RE2 regex, not a literal: \`a.b\` also matches aXb. A space means AND (within one file), lowercase \`or\` means OR, and parentheses group. \`and\` is not an operator; it is searched as text. \`X or Y r:z\` means \`X or (Y r:z)\`, so write \`(X or Y) r:z\`.
- Case is smart by default: all-lowercase terms ignore case, any capital makes the term case-sensitive. \`case:yes\` and \`case:no\` force it.
- A leading \`-\` negates a term or filter.
- Filters: \`r:\` or \`repo:\` (regex on the repo name, case-sensitive; use \`r:(?i)acme\`); \`f:\` or \`file:\` (regex on the path); \`lang:go\` (no short form; an unknown language matches nothing); \`b:\` or \`branch:\` (substring of the branch name; \`branch:HEAD\` is the default branch); \`c:\` (file content only); \`archived:\`, \`fork:\`, \`public:\` with yes or no; \`meta.<field>:\` (regex on repo metadata).
- \`sym:Name\` finds symbol definitions. It needs an index built with ctags; zero results may mean there are no symbols, so retry as plain text.
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
Repos appear as \`# <repo>\` and files as \`## <path>\`. Rows are \`<line>:<text>\` for matches and \`<line>-<text>\` for context; \`--\` separates non-adjacent groups. Results are bounded by maxFiles and an output size cap (\`[output truncated]\`); the footer after \`---\` says what was cut. If it was cut, narrow the query with \`r:\`, \`f:\` or \`lang:\` instead of repeating it.`;

export const searchTool: Tool<typeof inputSchema> = {
	name: "search",
	title: "Search code",
	annotations: READ_ONLY_ANNOTATIONS,
	description,
	inputSchema,
	async execute(client, { query, maxFiles, contextLines }, ctx) {
		// Ask for one file more than shown, so Zoekt's own cap cannot hide that there were more.
		const response = await client.search(
			{ query, num: maxFiles + 1, contextLines },
			{ signal: ctx.signal },
		);
		return formatSearch(response, {
			query,
			contextLines,
			maxFiles,
			maxChars: DEFAULT_OUTPUT_CHARS,
		});
	},
};
