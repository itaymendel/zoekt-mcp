import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
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
import type { ZoektClient } from "./zoekt/client.js";

/** Dependencies shared by every server instance; built once at startup. */
export interface ServerDeps {
	client: ZoektClient;
	logger: Logger;
}

function createToolHandler<I>(
	logger: Logger,
	toolName: string,
	execute: (input: I) => Promise<string>,
) {
	// The SDK validates, strips unknown keys and applies defaults before invoking the handler.
	// `_ctx` is unused for now; ctx.mcpReq.signal is the hook for request cancellation.
	return async (input: I, _ctx: ServerContext) => {
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

/** Pure: builds a fresh McpServer around the given dependencies and holds no other state. */
export function createMcpServer({ client: zoektClient, logger }: ServerDeps): McpServer {
	const server = new McpServer({
		name: pkg.name,
		version: pkg.version,
	});

	server.registerTool(
		"search",
		{ description: searchDescription, inputSchema: searchSchema },
		createToolHandler(logger, "search", (input: SearchInput) => executeSearch(zoektClient, input)),
	);

	server.registerTool(
		"list_repos",
		{ description: listReposDescription, inputSchema: listReposSchema },
		createToolHandler(logger, "list_repos", (input: ListReposInput) =>
			executeListRepos(zoektClient, input),
		),
	);

	server.registerTool(
		"file_content",
		{ description: fileContentDescription, inputSchema: fileContentSchema },
		createToolHandler(logger, "file_content", (input: FileContentInput) =>
			executeFileContent(zoektClient, input),
		),
	);

	return server;
}

/** A factory for per-request servers; the Zoekt client is shared, not rebuilt. */
export function createServerFactory(deps: ServerDeps): () => McpServer {
	return () => createMcpServer(deps);
}
