import { clipLineTail } from "./clip.js";
import { plural } from "./utils.js";
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

export interface FileWindowInput {
	repo: string;
	path: string;
	branch?: string;
	startLine: number;
	/** Already defaulted and validated (`>= startLine`); clamped here to `MAX_WINDOW_LINES`. */
	endLine: number;
}

export interface FileWindow {
	file: FileContent;
	/** The request was wider than `MAX_WINDOW_LINES` and was cut. */
	clamped: boolean;
}

/** Thrown when the bytes cannot be shown as text (NUL byte in the first chunk). */
export class BinaryContentError extends Error {}

/** Turns fetched bytes into the requested numbered window. Pure. */
export function buildFileContent(
	bytes: Uint8Array,
	fetchTruncated: boolean,
	input: FileWindowInput,
): FileWindow {
	if (bytes.subarray(0, 8000).includes(0)) {
		throw new BinaryContentError(
			`File looks binary (contains NUL bytes): ${input.repo}:${input.path}. read_file returns text files only.`,
		);
	}
	let text = new TextDecoder().decode(bytes);
	if (fetchTruncated) {
		// The last line was cut mid-way; only complete lines are reported.
		const cut = text.lastIndexOf("\n");
		text = cut >= 0 ? text.slice(0, cut + 1) : text;
	}
	const lines = text === "" ? [] : text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const totalLines = lines.length;

	const { startLine } = input;
	const clamped = input.endLine - startLine + 1 > MAX_WINDOW_LINES;
	const requestedEnd = clamped ? startLine + MAX_WINDOW_LINES - 1 : input.endLine;
	const lastWanted = Math.min(requestedEnd, totalLines);

	const rows: string[] = [];
	let chars = 0;
	let charCut = false;
	for (let n = startLine; n <= lastWanted; n++) {
		const raw = lines[n - 1] ?? "";
		const row = `${n}:${clipLineTail(raw.endsWith("\r") ? raw.slice(0, -1) : raw, MAX_LINE_LENGTH)}`;
		if (rows.length > 0 && chars + row.length + 1 > MAX_OUTPUT_CHARS) {
			charCut = true;
			break;
		}
		rows.push(row);
		chars += row.length + 1;
	}
	const endLine = startLine + rows.length - 1;

	const file: FileContent = {
		repo: input.repo,
		path: input.path,
		...(input.branch ? { branch: input.branch } : {}),
		startLine,
		endLine,
		totalLines,
		totalLinesIsLowerBound: fetchTruncated,
		content: rows.join("\n"),
		truncated: false,
	};
	if (charCut) {
		file.truncated = true;
		file.truncationReason = "chars";
		file.nextStartLine = endLine + 1;
	} else if (endLine < totalLines) {
		file.truncated = true;
		file.truncationReason = "window";
		file.nextStartLine = endLine + 1;
	} else if (fetchTruncated) {
		file.truncated = true;
		file.truncationReason = "fetchCap";
	}
	return { file, clamped };
}

/** The text shown to the model: `# repo`, `## path  (N lines)`, numbered rows, footer. */
export function formatFileContent(file: FileContent, { clamped = false } = {}): string {
	const { totalLines: total } = file;
	const count = `${file.totalLinesIsLowerBound ? "at least " : ""}${total} ${plural(total, "line")}`;
	const parts = [`# ${file.repo}`, `## ${file.path}  (${count})`];
	if (clamped) {
		parts.push(`Note: the requested range was clamped to ${MAX_WINDOW_LINES} lines per call.`);
	}
	parts.push("");

	if (file.content === "") {
		parts.push(
			total === 0
				? "The file is empty."
				: `startLine=${file.startLine} is past the end of the file (${count}).`,
		);
		return parts.join("\n");
	}
	parts.push(file.content, "");

	const shown = `lines ${file.startLine}-${file.endLine}`;
	const of = `of ${file.totalLinesIsLowerBound ? "at least " : ""}${total}`;
	switch (file.truncationReason) {
		case "window":
			parts.push(
				`Truncated: showing ${shown} ${of}. Continue with startLine=${file.nextStartLine}.`,
			);
			break;
		case "chars":
			parts.push(
				`Truncated: the ${MAX_OUTPUT_CHARS.toLocaleString("en-US")}-character output limit was reached after line ${file.endLine} (${shown} ${of}). Continue with startLine=${file.nextStartLine}.`,
			);
			break;
		case "fetchCap":
			parts.push(
				`Truncated: read stopped at the ${MAX_FETCH_BYTES / (1024 * 1024)} MiB fetch limit after line ${file.endLine}; later lines are not available.`,
			);
			break;
		default:
			parts.push("End of file.");
	}
	return parts.join("\n");
}
