/** What a tool's execute function returns: the text shown to the model, plus optional typed data. */
export interface ToolResult<T = unknown> {
	text: string;
	data?: T;
}

/** Per-call context handed to every tool's execute function. */
export interface ToolContext {
	/** Aborted when the MCP client cancels the request or disconnects. */
	signal: AbortSignal;
}
