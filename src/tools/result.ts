/** What a tool's execute function returns: the text shown to the model, plus optional typed data. */
export interface ToolResult<T = unknown> {
	text: string;
	data?: T;
	/** Small scalar facts about the call, logged at debug level on completion. */
	summary?: Record<string, string | number | boolean>;
}

/** Per-call context handed to every tool's execute function. */
export interface ToolContext {
	/** Aborted when the MCP client cancels the request or disconnects. */
	signal: AbortSignal;
}
