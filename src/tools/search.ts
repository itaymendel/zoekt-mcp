import { z } from "zod";
import { CONTEXT_LINES, DEFAULT_OUTPUT_CHARS, formatSearch } from "../search-format.js";
import { ZoektQueryError } from "../zoekt/errors.js";
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
});

const description = `Search code with Zoekt. Results are grouped by repo and file as \`<line>:<text>\` rows (\`<line>-<text>\` is context); pass the printed repo and path to read_file. Full query language: the \`search_syntax\` tool. If the footer says results were cut, narrow with \`r:\`, \`f:\` or \`lang:\` rather than repeating the query.

## Query syntax
- Every word is an unanchored RE2 regex, not a literal: \`a.b\` also matches aXb. A space means AND (within one file), lowercase \`or\` means OR, parentheses group. \`and\` is not an operator. \`X or Y r:z\` means \`X or (Y r:z)\`, so write \`(X or Y) r:z\`.
- Case is smart: all-lowercase terms ignore case, any capital makes the term case-sensitive. \`case:yes\` / \`case:no\` force it.
- A leading \`-\` negates a term or filter.
- Filters: \`r:\` (regex on the repo name, case-sensitive; use \`r:(?i)acme\`), \`f:\` (regex on the path), \`lang:go\` (an unknown language matches nothing), \`b:\` (branch; \`b:HEAD\` is the default branch), \`c:\` (content only).
- \`sym:Name\` finds symbol definitions and needs a ctags-built index; zero results may mean no symbols, so retry as plain text.
- \`type:file\` returns matching file paths only. Use it to find files by name.
- Quote a phrase to keep it together; inside quotes write \`\\\\.\` for a literal dot.

## Examples
- \`handleRequest\\( lang:go -f:_test\`
- \`sym:Server f:\\.ts$\`
- \`type:file f:docker-compose\`
- \`(foo or bar) r:(?i)acme\``;

export const searchTool: Tool<typeof inputSchema> = {
	name: "search",
	title: "Search code",
	description,
	inputSchema,
	async execute(client, { query, maxFiles }, ctx) {
		// Ask for one file more than shown, so Zoekt's own cap cannot hide that there were more.
		const response = await client
			.search({ query, num: maxFiles + 1, contextLines: CONTEXT_LINES }, { signal: ctx.signal })
			.catch((error) => {
				if (!(error instanceof ZoektQueryError)) throw error;
				throw new Error(`${error.message}\nSee the search_syntax tool for the query language.`);
			});
		return formatSearch(response, {
			query,
			maxFiles,
			maxChars: DEFAULT_OUTPUT_CHARS,
		});
	},
};
