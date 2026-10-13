import { z } from "zod";
import { formatFileContentAsText } from "../utils.js";
import type { ZoektClient } from "../zoekt/client.js";
import type { ToolContext } from "./result.js";

export const fileContentSchema = z.object({
	repository: z.string().describe("Repository name (e.g., 'github.com/org/repo')"),
	filePath: z.string().describe("Path to file within the repository"),
	branch: z.string().optional().describe("Branch name (defaults to default branch)"),
});

export type FileContentInput = z.infer<typeof fileContentSchema>;

export const fileContentDescription = `Retrieve full file content from an indexed repository.

Use this after searching to get the complete contents of a file.

### Parameters
- \`repository\`: Full repository name as shown in search results
- \`filePath\`: Path to the file within the repository
- \`branch\`: Optional branch name (uses default branch if not specified)

### Examples
- \`{ "repository": "github.com/org/repo", "filePath": "src/main.ts" }\`
- \`{ "repository": "github.com/org/repo", "filePath": "README.md", "branch": "develop" }\``;

export async function executeFileContent(
	client: ZoektClient,
	input: FileContentInput,
	ctx: ToolContext,
): Promise<string> {
	const content = await client.getFileContent(input.repository, input.filePath, input.branch, {
		signal: ctx.signal,
	});

	return formatFileContentAsText(input.repository, input.filePath, content, input.branch);
}
