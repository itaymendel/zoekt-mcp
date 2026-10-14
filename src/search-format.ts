import { clipLine, cutEnd, splitLines, stripEol } from "./clip.js";
import { pathHeading, plural, repoHeading } from "./utils.js";
import type { FileMatch, Match, SearchResponse } from "./zoekt/types.js";

/** Character cap on the results of one `search` (the footer comes on top). */
export const DEFAULT_OUTPUT_CHARS = 20_000;
/** Separates the results from the footer. */
const FOOTER_RULE = "---";
const BLOCK_SEPARATOR = "\n\n";

export interface SearchFormatOptions {
	query: string;
	/** Context lines to keep on each side of a match (Zoekt already limits them via `ctx`). */
	contextLines: number;
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
function addContext(byLine: Map<number, SearchLine>, m: Match, contextLines: number) {
	const put = (n: number, text: string) => {
		if (n >= 1 && !byLine.has(n)) byLine.set(n, { n, text, match: false });
	};
	// `Before`/`After` are newline-terminated blocks.
	const before = splitLines(m.Before).map(stripEol).slice(-contextLines);
	before.forEach((text, i) => {
		put(m.LineNum - before.length + i, text);
	});
	splitLines(m.After)
		.map(stripEol)
		.slice(0, contextLines)
		.forEach((text, i) => {
			put(m.LineNum + 1 + i, text);
		});
}

function normalizeFile(file: FileMatch, { contextLines }: SearchFormatOptions): SearchFile {
	const filenameMatch = file.Matches.some((m) => m.LineNum === 0);
	const content = file.Matches.filter((m) => m.LineNum > 0);

	const byLine = new Map<number, SearchLine>();
	for (const m of content) {
		byLine.set(m.LineNum, matchLine(m));
	}
	if (contextLines > 0) for (const m of content) addContext(byLine, m, contextLines);

	return {
		repo: file.Repo,
		path: file.FileName,
		branches: file.Branches,
		filenameMatch,
		lines: [...byLine.values()].sort((a, b) => a.n - b.n),
	};
}

/**
 * Zoekt gives no other signal for files it skipped (binary, too large): it indexes a stub whose
 * first line starts with `NOT-INDEXED`. Heuristic: a real file whose first line begins with that
 * word is shown as not indexed too.
 */
const NOT_INDEXED = /^NOT-INDEXED\b/;

function isNotIndexed(file: SearchFile) {
	const first = file.lines[0];
	return first?.n === 1 && first.match && NOT_INDEXED.test(first.text);
}

const branchKey = (f: SearchFile) => f.branches.join("\n");

/** Branches are shown only when they tell files apart: not all identical, and not just HEAD. */
function showBranches(files: SearchFile[]) {
	const first = files[0];
	return first !== undefined && files.some((f) => branchKey(f) !== branchKey(first));
}

function fileHeader(file: SearchFile, withBranches: boolean) {
	let header = pathHeading(file.path);
	if (isNotIndexed(file)) return `${header}  [not indexed: binary/too large]`;
	if (file.filenameMatch && file.lines.length === 0) header += "  [filename match]";
	const only = file.branches.length === 1 && file.branches[0] === "HEAD";
	if (withBranches && file.branches.length > 0 && !only) {
		header += `  (branches: ${file.branches.join(", ")})`;
	}
	return header;
}

/** The rows of one line: a `--` gap marker when it does not follow `prev`, then the line itself. */
function lineRows(l: SearchLine, prev: number): string[] {
	const row = `${l.n}${l.match ? ":" : "-"}${clipLine(l.text, { focus: l.focus })}`;
	return prev > 0 && l.n !== prev + 1 ? ["--", row] : [row];
}

function renderFile(file: SearchFile, withBranches: boolean): string {
	const out = [fileHeader(file, withBranches)];
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
	const ranked = FileMatches.slice(0, opts.maxFiles).map((f) => normalizeFile(f, opts));
	if (ranked.length === 0) return `No matches for \`${opts.query}\`.`;

	const totalFiles = Math.max(Stats?.FileCount ?? 0, FileMatches.length);
	const withBranches = showBranches(ranked);

	const groups = new Map<string, string[]>(); // repo -> blocks, in first-appearance order
	let shown = 0;
	let used = 0;
	let capped = false;
	for (const file of ranked) {
		let block = renderFile(file, withBranches);
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

	const count = (n: number, noun: string) => `${n} ${plural(n, noun)}`;
	let footer: string;
	if (totalFiles > shown) {
		const atLeast = Stats ? "" : "at least ";
		footer = `Showing ${shown} of ${atLeast}${totalFiles} files; narrow with r:/f:/lang:`;
	} else {
		// Without Stats, count filename matches too: the footer subtracts them again.
		const matches =
			Stats?.MatchCount ||
			ranked.reduce(
				(n, f) => n + f.lines.filter((l) => l.match).length + (f.filenameMatch ? 1 : 0),
				0,
			);
		const filenameMatches = ranked.filter((f) => f.filenameMatch).length;
		const lines = Math.max(matches - filenameMatches, 0);
		const lowerBound = (Stats?.FilesSkipped ?? 0) > 0 || (Stats?.ShardsSkipped ?? 0) > 0;
		const parts = [`${lowerBound ? "At least " : ""}${count(totalFiles, "file")}`];
		if (lines > 0 || filenameMatches === 0) parts.push(count(lines, "matching line"));
		if (filenameMatches > 0)
			parts.push(`${filenameMatches} filename ${plural(filenameMatches, "match", "matches")}`);
		footer = `${parts.join(", ")}.`;
	}
	return `${body}${BLOCK_SEPARATOR}${FOOTER_RULE}\n${footer}`;
}
