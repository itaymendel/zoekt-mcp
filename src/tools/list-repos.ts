import { z } from "zod";
import { formatRepositoriesAsText } from "../utils.js";
import type { ZoektClient } from "../zoekt/client.js";

export const listReposSchema = z.object({
	filter: z.string().optional().describe("Optional regex pattern to filter repository names"),
});

export type ListReposInput = z.infer<typeof listReposSchema>;

export const listReposDescription = `List indexed repositories.

Returns all repositories indexed by Zoekt. Optionally filter by name pattern.

### Examples
- List all repos: \`{}\`
- Filter by org: \`{ "filter": "github.com/myorg/.*" }\`
- Filter by name: \`{ "filter": "api" }\``;

export async function executeListRepos(
	client: ZoektClient,
	input: ListReposInput,
): Promise<string> {
	const response = await client.listRepositories(input.filter);
	return formatRepositoriesAsText(response);
}
