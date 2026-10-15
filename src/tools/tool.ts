import type { z } from "zod";
import type { ZoektClient } from "../zoekt/client.js";

/** One MCP tool: everything `createMcpServer` needs to register it. */
export interface Tool<S extends z.ZodObject = z.ZodObject> {
	name: string;
	title: string;
	description: string;
	inputSchema: S;
	/** Receives input already validated and defaulted by the SDK; returns the text shown to the model. */
	execute(client: ZoektClient, input: z.infer<S>, ctx: { signal: AbortSignal }): Promise<string>;
}
