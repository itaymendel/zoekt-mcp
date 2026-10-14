import { cutEnd, splitLines, stripEol } from "./clip.js";
import { pathHeading, plural, repoHeading } from "./utils.js";

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

/**
 * The text shown to the model for the window `range` asks for, in the layout of search output:
 * `# repo`, `## path  (N lines)`, numbered rows, then a blank line, `---` and the footer. The
 * empty-file and past-end messages (no rows) follow the same `\n---\n` footer shape. Pure.
 */
export function formatFile(
	bytes: Uint8Array,
	fetchTruncated: boolean,
	file: { repo: string; path: string },
	{ startLine, endLine: wantedEnd, clamped }: FileRange,
): string {
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
	const total = lines.length;

	const rows: string[] = [];
	let chars = 0;
	let charCut = false;
	for (let n = startLine; n <= Math.min(wantedEnd, total); n++) {
		const raw = stripEol(lines[n - 1] ?? "");
		const end = cutEnd(raw, MAX_LINE_LENGTH);
		const clipped =
			raw.length <= MAX_LINE_LENGTH ? raw : `${raw.slice(0, end)}…[+${raw.length - end} chars]`;
		const row = `${n}:${clipped}`;
		if (rows.length > 0 && chars + row.length + 1 > MAX_OUTPUT_CHARS) {
			charCut = true;
			break;
		}
		rows.push(row);
		chars += row.length + 1;
	}
	const endLine = startLine + rows.length - 1;

	const atLeast = fetchTruncated ? "at least " : "";
	const count = `${atLeast}${total} ${plural(total, "line")}`;
	const shown = `lines ${startLine}-${endLine} of ${atLeast}${total}`;
	const mib = MAX_FETCH_BYTES / (1024 * 1024);
	let footer: string;
	if (total === 0) footer = "The file is empty.";
	else if (rows.length === 0 && fetchTruncated) {
		footer = `startLine=${startLine} is beyond the ${mib} MiB read limit; only the first ${total} lines are readable.`;
	} else if (rows.length === 0) {
		footer = `startLine=${startLine} is past the end of the file (${count}).`;
	} else if (charCut) {
		footer = `Truncated: the ${MAX_OUTPUT_CHARS.toLocaleString("en-US")}-character output limit was reached after line ${endLine} (${shown}). Continue with startLine=${endLine + 1}.`;
	} else if (endLine < total) {
		footer = `Truncated: showing ${shown}. Continue with startLine=${endLine + 1}.`;
	} else if (fetchTruncated) {
		footer = `Truncated: read stopped at the ${mib} MiB fetch limit after line ${endLine}; later lines are not available.`;
	} else {
		footer = "End of file.";
	}

	const out = [repoHeading(file.repo), pathHeading(file.path, `(${count})`)];
	if (clamped) {
		out.push(`Note: the requested range was clamped to ${MAX_WINDOW_LINES} lines per call.`);
	}
	out.push(...rows, "", "---", footer);
	return out.join("\n");
}
