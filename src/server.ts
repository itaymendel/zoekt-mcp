import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json";
import type { Logger } from "./logger.js";
import {
	executeFileContent,
	type FileContentInput,
	fileContentDescription,
	fileContentSchema,
} from "./tools/file-content.js";
import {
	executeListRepos,
	type ListReposInput,
	listReposDescription,
	listReposSchema,
} from "./tools/list-repos.js";
import {
	executeSearch,
	type SearchInput,
	searchDescription,
	searchSchema,
} from "./tools/search.js";
import { getErrorMessage } from "./utils.js";
import { ZoektClient } from "./zoekt/client.js";

export interface CreateServerOptions {
	zoektUrl: string;
	zoektTimeoutMs: number;
	logger: Logger;
}

function createToolHandler<I>(
	logger: Logger,
	toolName: string,
	execute: (input: I) => Promise<string>,
) {
	// The SDK validates, strips unknown keys and applies defaults before invoking the handler.
	return async (input: I) => {
		try {
			logger.debug({ tool: toolName, input }, `Executing ${toolName}`);
			const result = await execute(input);
			return { content: [{ type: "text" as const, text: result }] };
		} catch (error) {
			const message = getErrorMessage(error);
			logger.error({ tool: toolName, error: message }, `${toolName} failed`);
			return {
				content: [{ type: "text" as const, text: `${toolName} error: ${message}` }],
				isError: true as const,
			};
		}
	};
}

export function createMcpServer({
	zoektUrl,
	zoektTimeoutMs,
	logger,
}: CreateServerOptions): McpServer {
	const zoektClient = new ZoektClient({ baseUrl: zoektUrl, timeoutMs: zoektTimeoutMs, logger });

	const server = new McpServer({
		name: pkg.name,
		version: pkg.version,
	});

	server.registerTool(
		"search",
		{ description: searchDescription, inputSchema: searchSchema.shape },
		createToolHandler(logger, "search", (input: SearchInput) => executeSearch(zoektClient, input)),
	);

	server.registerTool(
		"list_repos",
		{ description: listReposDescription, inputSchema: listReposSchema.shape },
		createToolHandler(logger, "list_repos", (input: ListReposInput) =>
			executeListRepos(zoektClient, input),
		),
	);

	server.registerTool(
		"file_content",
		{ description: fileContentDescription, inputSchema: fileContentSchema.shape },
		createToolHandler(logger, "file_content", (input: FileContentInput) =>
			executeFileContent(zoektClient, input),
		),
	);

	return server;
}
