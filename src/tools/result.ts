/** What a tool's execute function returns: the text shown to the model and the structured payload. */
export interface ToolResult<T> {
	text: string;
	/** The public `structuredContent`; must satisfy the tool's `outputSchema`. */
	structured: T;
	/** Small scalar facts about the call, logged at debug level on completion. */
	summary?: Record<string, string | number | boolean>;
}

/** Per-call context handed to every tool's execute function. */
export interface ToolContext {
	/** Aborted when the MCP client cancels the request or disconnects. */
	signal: AbortSignal;
}
