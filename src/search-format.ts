import { clipLine, cutEnd, splitLines, stripEol } from "./clip.js";
import { pathHeading, plural, repoHeading } from "./utils.js";
import type { FileMatch, Match, SearchResponse } from "./zoekt/types.js";

/** Output budget in characters for one `search` result (footer included, give or take the reserve). */
export const DEFAULT_OUTPUT_CHARS = 20_000;
/** Characters kept free for the footer when files are packed into the budget. */
export const FOOTER_RESERVE = 600;
/** The first file is always shown, even when the budget is smaller than this. */
const MIN_FIRST_FILE_CHARS = 200;
/** Separates the results from the footer. */
const FOOTER_RULE = "---";
const BLOCK_SEPARATOR = "\n\n";

export interface SearchFormatOptions {
	query: string;
	/** Context lines to keep on each side of a match (Zoekt already limits them via `ctx`). */
	contextLines: number;
	/** Files shown; totals still count the rest. */
	maxFiles: number;
	/** Matching lines kept per file, in Zoekt's (score) order; context excluded. */
	maxMatchesPerFile: number;
	/** Output budget in characters. */
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
	/** Matching lines dropped by `maxMatchesPerFile` and not shown as context either. */
	hiddenMatchLines: number;
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

function normalizeFile(
	file: FileMatch,
	{ contextLines, maxMatchesPerFile }: SearchFormatOptions,
): SearchFile {
	const filenameMatch = file.Matches.some((m) => m.LineNum === 0);
	const all = file.Matches.filter((m) => m.LineNum > 0);
	// The cap applies before context is attached; Zoekt's order is score order, not line order.
	const content = all.slice(0, maxMatchesPerFile);

	const byLine = new Map<number, SearchLine>();
	for (const m of content) {
		byLine.set(m.LineNum, matchLine(m));
	}
	if (contextLines > 0) for (const m of content) addContext(byLine, m, contextLines);

	// Hidden lines that already appear as context are not hidden.
	let hiddenMatchLines = 0;
	if (all.length > content.length) {
		const kept = new Set(content.map((m) => m.LineNum));
		const hidden = all.filter((m) => !kept.has(m.LineNum) && !byLine.has(m.LineNum));
		hiddenMatchLines = new Set(hidden.map((m) => m.LineNum)).size;
	}

	return {
		repo: file.Repo,
		path: file.FileName,
		branches: file.Branches,
		filenameMatch,
		lines: [...byLine.values()].sort((a, b) => a.n - b.n),
		hiddenMatchLines,
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
		if (file.hiddenMatchLines > 0) {
			const n = file.hiddenMatchLines;
			out.push(`[+${n} more matching ${plural(n, "line")} in this file]`);
		}
	}
	return out.join("\n");
}

const repoLead = (repo: string) => `${repoHeading(repo)}\n`;

/**
 * Zoekt answer -> the text a client sees; see the tool description. Applies `maxFiles`, the
 * per-file match cap and the output budget (the first file is hard-clipped if it alone exceeds it),
 * and ends with a footer naming whatever was left out.
 */
export function formatSearch(response: SearchResponse, opts: SearchFormatOptions): string {
	const { FileMatches, Stats } = response.result;
	const { maxChars, maxMatchesPerFile } = opts;
	const ranked = FileMatches.slice(0, opts.maxFiles).map((f) => normalizeFile(f, opts));
	if (ranked.length === 0) return `No matches for \`${opts.query}\`.`;

	const totalFiles = Math.max(Stats?.FileCount ?? 0, FileMatches.length);
	const lowerBound = (Stats?.FilesSkipped ?? 0) > 0 || (Stats?.ShardsSkipped ?? 0) > 0;
	const moreFiles = Math.max(0, totalFiles - ranked.length);
	const withBranches = showBranches(ranked);

	const budget = Math.max(maxChars - FOOTER_RESERVE, 0);
	const firstLimit = Math.max(budget, MIN_FIRST_FILE_CHARS);
	const groups = new Map<string, string[]>(); // repo -> blocks, in first-appearance order
	const shown: SearchFile[] = [];
	let used = 0;
	let firstClipped = false;
	for (const file of ranked) {
		let block = renderFile(file, withBranches);
		if (shown.length === 0) {
			firstClipped = block.length > firstLimit;
			if (firstClipped) block = `${block.slice(0, cutEnd(block, firstLimit))}\n[output truncated]`;
		}
		const group = groups.get(file.repo);
		const cost = block.length + BLOCK_SEPARATOR.length + (group ? 0 : repoLead(file.repo).length);
		if (shown.length > 0 && used + cost > budget) break;
		if (group) group.push(block);
		else groups.set(file.repo, [block]);
		shown.push(file);
		used += cost;
	}
	const body = [...groups]
		.map(([repo, blocks]) => repoLead(repo) + blocks.join(BLOCK_SEPARATOR))
		.join(BLOCK_SEPARATOR);

	const hiddenMatchLines = shown.reduce((n, f) => n + f.hiddenMatchLines, 0);
	const budgetCut = shown.length < ranked.length || firstClipped;
	const atLeast = lowerBound ? "at least " : "";
	const count = (n: number, noun: string) => `${n} ${plural(n, noun)}`;

	let footer: string;
	if (moreFiles === 0 && hiddenMatchLines === 0 && !budgetCut) {
		// Without Stats, count filename matches too: the footer subtracts them again.
		const matches =
			Stats?.MatchCount ||
			ranked.reduce(
				(n, f) => n + f.lines.filter((l) => l.match).length + (f.filenameMatch ? 1 : 0),
				0,
			);
		const filenameMatches = shown.filter((f) => f.filenameMatch).length;
		const lines = Math.max(matches - filenameMatches, 0);
		const parts = [`${lowerBound ? "At least " : ""}${count(totalFiles, "file")}`];
		if (lines > 0 || filenameMatches === 0) parts.push(count(lines, "matching line"));
		if (filenameMatches > 0)
			parts.push(`${filenameMatches} filename ${plural(filenameMatches, "match", "matches")}`);
		footer = `${parts.join(", ")}.`;
	} else {
		const clauses: string[] = [];
		if (moreFiles > 0) clauses.push(`showing ${shown.length} of ${atLeast}${totalFiles} files`);
		if (hiddenMatchLines > 0) {
			clauses.push(
				`${count(hiddenMatchLines, "more matching line")} hidden by maxMatchesPerFile=${maxMatchesPerFile}`,
			);
		}
		if (budgetCut) {
			// With no files cut by maxFiles the budget clause is the one that counts them, bound included.
			const total =
				moreFiles > 0 ? count(ranked.length, "file") : `${atLeast}${count(totalFiles, "file")}`;
			clauses.push(`output budget (${maxChars} chars) reached after ${shown.length} of ${total}`);
		} else if (lowerBound && moreFiles === 0) {
			clauses.push(`at least ${count(totalFiles, "file")} matched`);
		}
		footer = `Truncated: ${clauses.join("; ")}. Refine with repo:, file:, lang: or -file: filters, or raise maxFiles / maxMatchesPerFile.`;
	}
	return `${body}${BLOCK_SEPARATOR}${FOOTER_RULE}\n${footer}`;
}
