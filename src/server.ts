import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import pkg from "../package.json";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import type { Logger } from "./logger.js";
import { listReposTool } from "./tools/list-repos.js";
import { readFileTool } from "./tools/read-file.js";
import { searchTool } from "./tools/search.js";
import { searchSyntaxTool } from "./tools/search-syntax.js";
import type { Tool } from "./tools/tool.js";
import { getErrorMessage } from "./utils.js";
import type { ZoektClient } from "./zoekt/client.js";

/** Dependencies shared by every server instance; built once at startup. */
export interface ServerDeps {
	client: ZoektClient;
	logger: Logger;
}

const TOOLS: Tool[] = [searchTool, searchSyntaxTool, listReposTool, readFileTool];

/** Every tool only reads from Zoekt. */
const READ_ONLY_ANNOTATIONS = {
	readOnlyHint: true,
	idempotentHint: true,
	destructiveHint: false,
	openWorldHint: false,
};

/** Builds a fresh McpServer around the given dependencies; the Zoekt client is shared. */
export function createMcpServer(deps: ServerDeps): McpServer {
	const server = new McpServer(
		{ name: pkg.name, version: pkg.version, title: "Zoekt Code Search" },
		{ instructions: SERVER_INSTRUCTIONS },
	);

	const { client, logger } = deps;
	for (const tool of TOOLS) {
		const { name, title, description, inputSchema } = tool;
		// The SDK validates, strips unknown keys and applies defaults before invoking the handler.
		server.registerTool(
			name,
			{ title, annotations: READ_ONLY_ANNOTATIONS, description, inputSchema },
			async (input: Record<string, unknown>, ctx: ServerContext) => {
				try {
					logger.debug({ tool: name, input }, `Executing ${name}`);
					const text = await tool.execute(client, input, { signal: ctx.mcpReq.signal });
					logger.debug({ tool: name }, `${name} finished`);
					return { content: [{ type: "text" as const, text }] };
				} catch (error) {
					const message = getErrorMessage(error);
					logger.error({ tool: name, error: message }, `${name} failed`);
					return {
						content: [{ type: "text" as const, text: `${name} error: ${message}` }],
						isError: true as const,
					};
				}
			},
		);
	}

	return server;
}
