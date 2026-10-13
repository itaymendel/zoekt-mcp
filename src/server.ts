import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import pkg from "../package.json";
import type { Logger } from "./logger.js";
import {
	executeListRepos,
	type ListReposInput,
	listReposDescription,
	listReposSchema,
} from "./tools/list-repos.js";
import {
	executeReadFile,
	type ReadFileInput,
	readFileDescription,
	readFileSchema,
} from "./tools/read-file.js";
import type { ToolContext, ToolResult } from "./tools/result.js";
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
	execute: (input: I, ctx: ToolContext) => Promise<string | ToolResult>,
) {
	// The SDK validates, strips unknown keys and applies defaults before invoking the handler.
	return async (input: I, ctx: ServerContext) => {
		try {
			logger.debug({ tool: toolName, input }, `Executing ${toolName}`);
			const result = await execute(input, { signal: ctx.mcpReq.signal });
			const text = typeof result === "string" ? result : result.text;
			const summary = typeof result === "string" ? undefined : result.summary;
			logger.debug({ tool: toolName, ...summary }, `${toolName} finished`);
			return { content: [{ type: "text" as const, text }] };
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
		createToolHandler(logger, "search", (input: SearchInput, ctx) =>
			executeSearch(zoektClient, input, ctx),
		),
	);

	server.registerTool(
		"list_repos",
		{ description: listReposDescription, inputSchema: listReposSchema },
		createToolHandler(logger, "list_repos", (input: ListReposInput, ctx) =>
			executeListRepos(zoektClient, input, ctx),
		),
	);

	server.registerTool(
		"read_file",
		{ description: readFileDescription, inputSchema: readFileSchema },
		createToolHandler(logger, "read_file", (input: ReadFileInput, ctx) =>
			executeReadFile(zoektClient, input, ctx),
		),
	);

	return server;
}

/** A factory for per-request servers; the Zoekt client is shared, not rebuilt. */
export function createServerFactory(deps: ServerDeps): () => McpServer {
	return () => createMcpServer(deps);
}
