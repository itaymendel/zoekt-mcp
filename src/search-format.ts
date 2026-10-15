import { clipLine, cutEnd, splitLines, stripEol } from "./clip.js";
import { pathHeading, plural, repoHeading } from "./utils.js";
import { notIndexedReason } from "./zoekt/errors.js";
import type { FileMatch, Match, SearchResponse } from "./zoekt/types.js";

/** Character cap on the results of one `search` (the footer comes on top). */
export const DEFAULT_OUTPUT_CHARS = 20_000;
/** Context lines kept on each side of a match; also what `search` asks Zoekt for (`ctx`). */
export const CONTEXT_LINES = 2;
/** Separates the results from the footer. */
const FOOTER_RULE = "---";
const BLOCK_SEPARATOR = "\n\n";

interface SearchFormatOptions {
	query: string;
	/** Files shown; totals still count the rest. */
	maxFiles: number;
	/** Character cap on the results; the first file is always shown, clipped to it. */
	maxChars: number;
}

/** A displayed line of a hit: a matching line (`match`) or a context line. */
interface SearchLine {
	/** 1-based line number. */
	n: number;
	/** Line text without the trailing newline; indentation preserved. */
	text: string;
	match: boolean;
	/** `[start, end)` of the first matched fragment within `text` (match lines only). */
	focus?: [number, number];
}

interface SearchFile {
	repo: string;
	path: string;
	branches: string[];
	/** The file's path itself matched (Zoekt reports LineNum 0). */
	filenameMatch: boolean;
	/** Matching lines plus context lines, sorted by `n`. */
	lines: SearchLine[];
}

/** One line per Zoekt `Match`: fragments concatenated, `focus` marking the first fragment's match. */
function matchLine(match: Match): SearchLine {
	let text = "";
	let focus: [number, number] | undefined;
	for (const f of match.Fragments) {
		text += f.Pre;
		focus ??= [text.length, text.length + f.Match.length];
		text += f.Match + f.Post;
	}
	const line: SearchLine = { n: match.LineNum, text: stripEol(text), match: true };
	if (focus) line.focus = focus;
	return line;
}

/** Adds the context rows of `m` to `byLine`; existing lines (matches included) win. */
function addContext(byLine: Map<number, SearchLine>, m: Match) {
	const put = (n: number, text: string) => {
		if (n >= 1 && !byLine.has(n)) byLine.set(n, { n, text, match: false });
	};
	// `Before`/`After` are newline-terminated blocks.
	const before = splitLines(m.Before).map(stripEol).slice(-CONTEXT_LINES);
	before.forEach((text, i) => {
		put(m.LineNum - before.length + i, text);
	});
	splitLines(m.After)
		.map(stripEol)
		.slice(0, CONTEXT_LINES)
		.forEach((text, i) => {
			put(m.LineNum + 1 + i, text);
		});
}

function normalizeFile(file: FileMatch): SearchFile {
	const filenameMatch = file.Matches.some((m) => m.LineNum === 0);
	const content = file.Matches.filter((m) => m.LineNum > 0);

	const byLine = new Map<number, SearchLine>();
	for (const m of content) {
		byLine.set(m.LineNum, matchLine(m));
	}
	for (const m of content) addContext(byLine, m);

	return {
		repo: file.Repo,
		path: file.FileName,
		branches: file.Branches,
		filenameMatch,
		lines: [...byLine.values()].sort((a, b) => a.n - b.n),
	};
}

function isNotIndexed(file: SearchFile) {
	const first = file.lines[0];
	return first?.n === 1 && first.match && notIndexedReason(first.text) !== undefined;
}

function fileHeader(file: SearchFile) {
	let header = pathHeading(file.path);
	if (isNotIndexed(file)) return `${header}  [not indexed: binary/too large]`;
	if (file.filenameMatch && file.lines.length === 0) header += "  [filename match]";
	const only = file.branches.length === 1 && file.branches[0] === "HEAD";
	if (file.branches.length > 0 && !only) {
		header += `  (branches: ${file.branches.join(", ")})`;
	}
	return header;
}

/** The rows of one line: a `--` gap marker when it does not follow `prev`, then the line itself. */
function lineRows(l: SearchLine, prev: number): string[] {
	const row = `${l.n}${l.match ? ":" : "-"}${clipLine(l.text, { focus: l.focus })}`;
	return prev > 0 && l.n !== prev + 1 ? ["--", row] : [row];
}

function renderFile(file: SearchFile): string {
	const out = [fileHeader(file)];
	if (!isNotIndexed(file)) {
		let prev = 0;
		for (const l of file.lines) {
			out.push(...lineRows(l, prev));
			prev = l.n;
		}
	}
	return out.join("\n");
}

const repoLead = (repo: string) => `${repoHeading(repo)}\n`;

/**
 * Zoekt answer -> the text a client sees; see the tool description. Applies `maxFiles` and the
 * character cap (the first file is clipped to it), and ends with a footer.
 */
export function formatSearch(response: SearchResponse, opts: SearchFormatOptions): string {
	const { FileMatches, Stats } = response.result;
	const { maxChars } = opts;
	const ranked = FileMatches.slice(0, opts.maxFiles).map((f) => normalizeFile(f));
	if (ranked.length === 0) return `No matches for \`${opts.query}\`.`;

	const totalFiles = Math.max(Stats?.FileCount ?? 0, FileMatches.length);

	const groups = new Map<string, string[]>(); // repo -> blocks, in first-appearance order
	let shown = 0;
	let used = 0;
	let capped = false;
	for (const file of ranked) {
		let block = renderFile(file);
		if (shown === 0 && block.length > maxChars) {
			block = block.slice(0, cutEnd(block, maxChars));
			capped = true;
		}
		const group = groups.get(file.repo);
		const cost = block.length + BLOCK_SEPARATOR.length + (group ? 0 : repoLead(file.repo).length);
		if (shown > 0 && used + cost > maxChars) {
			capped = true;
			break;
		}
		if (group) group.push(block);
		else groups.set(file.repo, [block]);
		shown++;
		used += cost;
	}
	let body = [...groups]
		.map(([repo, blocks]) => repoLead(repo) + blocks.join(BLOCK_SEPARATOR))
		.join(BLOCK_SEPARATOR);
	if (capped) body += "\n[output truncated]";

	const skipped = (Stats?.FilesSkipped ?? 0) > 0 || (Stats?.ShardsSkipped ?? 0) > 0;
	const footer =
		totalFiles > shown
			? `Showing ${shown} of ${totalFiles} files; narrow with r:/f:/lang:`
			: `${totalFiles} ${plural(totalFiles, "file")}${skipped ? " (incomplete: Zoekt skipped part of the index)" : ""}.`;
	return `${body}${BLOCK_SEPARATOR}${FOOTER_RULE}\n${footer}`;
}
