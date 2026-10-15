/** Server-level guidance delivered to the client at connect time (at most 120 words). */
export const SERVER_INSTRUCTIONS = `Code search over repositories indexed by Zoekt.

Workflow: list_repos shows what is indexed and the exact repository names. search finds code; narrow it with r:, f: and lang: filters. read_file reads a file: pass repo and path exactly as search prints them, and use startLine and endLine for a range.

Footers in tool output say what was cut or left out: refine the query instead of repeating it. The index can lag behind the source, and only indexed branches are searchable.`;
