import type { Logger } from "../logger.js";

/** What a tool's execute function returns: the text shown to the model, plus optional typed data. */
export interface ToolResult<T = unknown> {
	text: string;
	data?: T;
}

/** Per-call context handed to every tool's execute function. */
export interface ToolContext {
	/** Aborted when the MCP client cancels the request or disconnects. */
	signal: AbortSignal;
	/** For debug logging inside a tool; absent in unit tests that call `execute*` directly. */
	logger?: Logger;
}
