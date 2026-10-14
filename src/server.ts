import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import pkg from "../package.json";
import { SERVER_INSTRUCTIONS, TOOLS_CACHE_TTL_MS } from "./instructions.js";
import type { Logger } from "./logger.js";
import {
	executeListRepos,
	type ListReposInput,
	listReposDescription,
	listReposMeta,
	listReposSchema,
} from "./tools/list-repos.js";
import {
	executeReadFile,
	type ReadFileInput,
	readFileDescription,
	readFileMeta,
	readFileSchema,
} from "./tools/read-file.js";
import {
	executeSearch,
	type SearchInput,
	searchDescription,
	searchMeta,
	searchSchema,
} from "./tools/search.js";
import { getErrorMessage } from "./utils.js";
import type { ZoektClient } from "./zoekt/client.js";

/** Dependencies shared by every server instance; built once at startup. */
export interface ServerDeps {
	client: ZoektClient;
	logger: Logger;
	/** Required so a forgotten value cannot silently mean `public`; see `cacheScopeFor`. */
	cacheScope: CacheScope;
}

export type CacheScope = "public" | "private";

/** Tool listings are `private` when a bearer token guards the server, else `public`. */
export function cacheScopeFor(config: { mcpAuthToken?: string }): CacheScope {
	return config.mcpAuthToken === undefined ? "public" : "private";
}

const cacheHints = (cacheScope: CacheScope) => {
	const hint = { ttlMs: TOOLS_CACHE_TTL_MS, cacheScope };
	return { "tools/list": hint, "server/discover": hint };
};

/** Cache hints only reach 2026-era clients; `tools/list` never varies per caller. */
const CACHE_HINTS: Record<CacheScope, ReturnType<typeof cacheHints>> = {
	public: cacheHints("public"),
	private: cacheHints("private"),
};

function createToolHandler<I>(
	logger: Logger,
	toolName: string,
	execute: (input: I, ctx: { signal: AbortSignal }) => Promise<string>,
) {
	// The SDK validates, strips unknown keys and applies defaults before invoking the handler.
	return async (input: I, ctx: ServerContext) => {
		try {
			logger.debug({ tool: toolName, input }, `Executing ${toolName}`);
			const text = await execute(input, { signal: ctx.mcpReq.signal });
			logger.debug({ tool: toolName }, `${toolName} finished`);
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
export function createMcpServer({
	client: zoektClient,
	logger,
	cacheScope,
}: ServerDeps): McpServer {
	const server = new McpServer(
		{ name: pkg.name, version: pkg.version, title: "Zoekt Code Search" },
		{
			instructions: SERVER_INSTRUCTIONS,
			cacheHints: CACHE_HINTS[cacheScope],
		},
	);

	server.registerTool(
		"search",
		{
			...searchMeta,
			description: searchDescription,
			inputSchema: searchSchema,
		},
		createToolHandler(logger, "search", (input: SearchInput, ctx) =>
			executeSearch(zoektClient, input, ctx),
		),
	);

	server.registerTool(
		"list_repos",
		{
			...listReposMeta,
			description: listReposDescription,
			inputSchema: listReposSchema,
		},
		createToolHandler(logger, "list_repos", (input: ListReposInput, ctx) =>
			executeListRepos(zoektClient, input, ctx),
		),
	);

	server.registerTool(
		"read_file",
		{
			...readFileMeta,
			description: readFileDescription,
			inputSchema: readFileSchema,
		},
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
