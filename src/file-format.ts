import { clipLineTail, splitLines, stripEol } from "./clip.js";
import { pathHeading, plural, repoHeading } from "./utils.js";
import type { FileContent } from "./zoekt/types.js";

/** Lines returned when `endLine` is not given. */
export const DEFAULT_WINDOW_LINES = 500;
/** Most lines one call may return; wider requests are clamped. */
export const MAX_WINDOW_LINES = 2000;
/** Budget for the numbered rows of one call (header and footer excluded). */
export const MAX_OUTPUT_CHARS = 40_000;
/** A single line is clipped to this many characters. */
export const MAX_LINE_LENGTH = 2000;
/** `print` stops reading (and cancels the stream) after this many bytes. */
export const MAX_FETCH_BYTES = 8 * 1024 * 1024;

export interface FileRange {
	startLine: number;
	/** Last line wanted, after defaulting (`startLine + 499`) and clamping to `MAX_WINDOW_LINES`. */
	endLine: number;
	/** The request was wider than `MAX_WINDOW_LINES`. */
	clamped: boolean;
}

/** The only place that defaults, validates and clamps the requested range. */
export function resolveRange(startLine: number, endLine?: number): FileRange {
	const wanted = endLine ?? startLine + DEFAULT_WINDOW_LINES - 1;
	if (wanted < startLine) {
		throw new Error(`endLine (${wanted}) must not be before startLine (${startLine}).`);
	}
	const clamped = wanted - startLine + 1 > MAX_WINDOW_LINES;
	return { startLine, endLine: clamped ? startLine + MAX_WINDOW_LINES - 1 : wanted, clamped };
}

/** Turns fetched bytes into the numbered window `range` asks for. Pure. */
export function buildFileContent(
	bytes: Uint8Array,
	fetchTruncated: boolean,
	file: { repo: string; path: string; branch?: string },
	{ startLine, endLine: wantedEnd }: FileRange,
): FileContent {
	if (bytes.subarray(0, 8000).includes(0)) {
		throw new Error(
			`File looks binary (contains NUL bytes): ${file.repo}:${file.path}. read_file returns text files only.`,
		);
	}
	let text = new TextDecoder().decode(bytes);
	if (fetchTruncated) {
		// The last line was cut mid-way; only complete lines are reported.
		const cut = text.lastIndexOf("\n");
		text = cut >= 0 ? text.slice(0, cut + 1) : text;
	}
	const lines = splitLines(text);
	const totalLines = lines.length;

	const returned: FileContent["lines"] = [];
	let chars = 0;
	let charCut = false;
	for (let n = startLine; n <= Math.min(wantedEnd, totalLines); n++) {
		const text = clipLineTail(stripEol(lines[n - 1] ?? ""), MAX_LINE_LENGTH);
		const rowLength = `${n}:${text}`.length + 1;
		if (returned.length > 0 && chars + rowLength > MAX_OUTPUT_CHARS) {
			charCut = true;
			break;
		}
		returned.push({ line: n, text });
		chars += rowLength;
	}
	const endLine = startLine + returned.length - 1;

	let truncationReason: FileContent["truncationReason"];
	if (charCut) truncationReason = "chars";
	else if (endLine < totalLines) truncationReason = "window";
	else if (fetchTruncated) truncationReason = "fetchCap";

	return {
		...file,
		startLine,
		endLine,
		totalLines,
		totalLinesIsLowerBound: fetchTruncated,
		lines: returned,
		truncated: truncationReason !== undefined,
		...(truncationReason ? { truncationReason } : {}),
		...(truncationReason === "chars" || truncationReason === "window"
			? { nextStartLine: endLine + 1 }
			: {}),
	};
}

/**
 * The text shown to the model, in the layout of search output: `# repo`, `## path  (N lines)`,
 * numbered rows, then a blank line, `---` and the footer. The empty-file and past-end messages
 * (no rows) follow the same `\n---\n` footer shape.
 */
export function formatFileContent(file: FileContent, { clamped = false } = {}): string {
	const { totalLines: total } = file;
	const atLeast = file.totalLinesIsLowerBound ? "at least " : "";
	const count = `${atLeast}${total} ${plural(total, "line")}`;
	const out = [repoHeading(file.repo), pathHeading(file.path, `(${count})`)];
	if (clamped) {
		out.push(`Note: the requested range was clamped to ${MAX_WINDOW_LINES} lines per call.`);
	}
	for (const { line, text } of file.lines) out.push(`${line}:${text}`);
	out.push("", "---", footer(file, count, atLeast));
	return out.join("\n");
}

function footer(file: FileContent, count: string, atLeast: string): string {
	if (file.lines.length === 0) {
		if (file.totalLines === 0) return "The file is empty.";
		if (file.totalLinesIsLowerBound) {
			return `startLine=${file.startLine} is beyond the ${MAX_FETCH_BYTES / (1024 * 1024)} MiB read limit; only the first ${file.totalLines} lines are readable.`;
		}
		return `startLine=${file.startLine} is past the end of the file (${count}).`;
	}
	const shown = `lines ${file.startLine}-${file.endLine} of ${atLeast}${file.totalLines}`;
	switch (file.truncationReason) {
		case "window":
			return `Truncated: showing ${shown}. Continue with startLine=${file.nextStartLine}.`;
		case "chars":
			return `Truncated: the ${MAX_OUTPUT_CHARS.toLocaleString("en-US")}-character output limit was reached after line ${file.endLine} (${shown}). Continue with startLine=${file.nextStartLine}.`;
		case "fetchCap":
			return `Truncated: read stopped at the ${MAX_FETCH_BYTES / (1024 * 1024)} MiB fetch limit after line ${file.endLine}; later lines are not available.`;
		default:
			return "End of file.";
	}
}
