import { clipLine, hardClip } from "./clip.js";
import { plural } from "./utils.js";
import type {
	FileMatch,
	Match,
	SearchFile,
	SearchLine,
	SearchModel,
	SearchResponse,
} from "./zoekt/types.js";

/** Output budget in characters for one `search` result (footer included, give or take the reserve). */
export const DEFAULT_OUTPUT_CHARS = 20_000;
/** Characters kept free for the footer when files are packed into the budget. */
export const FOOTER_RESERVE = 600;
/** The first file is always shown, even when the budget is smaller than this. */
const MIN_FIRST_FILE_CHARS = 200;
/** Separates the results from the footer. */
const FOOTER_RULE = "---";
const BLOCK_SEPARATOR = "\n\n";

export interface NormalizeOptions {
	query: string;
	/** Context lines to keep on each side of a match (Zoekt already limits them via `ctx`). */
	contextLines: number;
	/** Matching lines kept per file, in Zoekt's (score) order; context excluded. */
	maxMatchesPerFile?: number;
	/** Only this many files are normalized; totals still count the rest. */
	maxFiles?: number;
}

const stripEol = (s: string) => {
	const noLf = s.endsWith("\n") ? s.slice(0, -1) : s;
	return noLf.endsWith("\r") ? noLf.slice(0, -1) : noLf;
};

/** `Before`/`After` are newline-terminated blocks; drop the one empty element after the last `\n`. */
function contextRows(block: string): string[] {
	if (block === "") return [];
	const rows = block.split("\n");
	if (rows[rows.length - 1] === "") rows.pop();
	return rows.map(stripEol);
}

/** One line per Zoekt `Match`: fragments concatenated, `ranges` marking each fragment's match. */
function matchLine(match: Match): SearchLine {
	let text = "";
	const ranges: Array<[number, number]> = [];
	for (const f of match.Fragments) {
		text += f.Pre;
		ranges.push([text.length, text.length + f.Match.length]);
		text += f.Match + f.Post;
	}
	const line: SearchLine = { n: match.LineNum, text: stripEol(text), match: true };
	if (ranges.length > 0) line.ranges = ranges;
	return line;
}

/** Adds the context rows of `m` to `byLine`; existing lines (matches included) win. */
function addContext(byLine: Map<number, SearchLine>, m: Match, contextLines: number) {
	const put = (n: number, text: string) => {
		if (n >= 1 && !byLine.has(n)) byLine.set(n, { n, text, match: false });
	};
	const before = contextRows(m.Before).slice(-contextLines);
	before.forEach((text, i) => {
		put(m.LineNum - before.length + i, text);
	});
	contextRows(m.After)
		.slice(0, contextLines)
		.forEach((text, i) => {
			put(m.LineNum + 1 + i, text);
		});
}

function normalizeFile(
	file: FileMatch,
	{ contextLines, maxMatchesPerFile = Number.POSITIVE_INFINITY }: NormalizeOptions,
): SearchFile {
	const filenameMatch = file.Matches.some((m) => m.LineNum === 0);
	const all = file.Matches.filter((m) => m.LineNum > 0);
	// The cap applies before context is attached; Zoekt's order is score order, not line order.
	const content = all.slice(0, maxMatchesPerFile);

	const byLine = new Map<number, SearchLine>();
	for (const m of content) byLine.set(m.LineNum, matchLine(m));
	if (contextLines > 0) for (const m of content) addContext(byLine, m, contextLines);

	// Hidden lines that already appear as context are not hidden.
	let hiddenMatchLines = 0;
	if (all.length > content.length) {
		const kept = new Set(content.map((m) => m.LineNum));
		const hidden = all.filter((m) => !kept.has(m.LineNum) && !byLine.has(m.LineNum));
		hiddenMatchLines = new Set(hidden.map((m) => m.LineNum)).size;
	}

	const out: SearchFile = {
		repo: file.Repo,
		path: file.FileName,
		branches: file.Branches,
		filenameMatch,
		lines: [...byLine.values()].sort((a, b) => a.n - b.n),
		hiddenMatchLines,
	};
	if (file.Language) out.language = file.Language;
	return out;
}

/** Zoekt answer -> model. Pure; only per-file caps apply here (see `capSearch` for the rest). */
export function normalizeSearch(response: SearchResponse, opts: NormalizeOptions): SearchModel {
	const { FileMatches, Stats } = response.result;
	const { maxFiles = Number.POSITIVE_INFINITY, maxMatchesPerFile = Number.POSITIVE_INFINITY } =
		opts;
	const files = FileMatches.slice(0, maxFiles).map((f) => normalizeFile(f, opts));
	const matchLines = files.reduce((n, f) => n + f.lines.filter((l) => l.match).length, 0);
	return {
		query: opts.query,
		files,
		totals: {
			files: Math.max(Stats?.FileCount ?? 0, FileMatches.length),
			filesIsLowerBound: (Stats?.FilesSkipped ?? 0) > 0 || (Stats?.ShardsSkipped ?? 0) > 0,
			matches: Stats?.MatchCount || matchLines,
		},
		truncated: false,
		truncation: { reasons: [], moreFiles: 0, hiddenMatchLines: 0, filesOmittedByBudget: 0 },
		durationMs: Math.round((Stats?.Duration ?? 0) / 1e6),
		limits: { maxFiles, maxMatchesPerFile, maxChars: DEFAULT_OUTPUT_CHARS },
		blocks: [],
	};
}

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
	let header = `## ${file.path}`;
	if (isNotIndexed(file)) return `${header}  [not indexed: binary/too large]`;
	if (file.filenameMatch && file.lines.length === 0) header += "  [filename match]";
	const only = file.branches.length === 1 && file.branches[0] === "HEAD";
	if (withBranches && file.branches.length > 0 && !only) {
		header += `  (branches: ${file.branches.join(", ")})`;
	}
	return header;
}

function renderFile(file: SearchFile, withBranches: boolean): string {
	const out = [fileHeader(file, withBranches)];
	if (!isNotIndexed(file)) {
		let prev = 0;
		for (const l of file.lines) {
			if (prev > 0 && l.n !== prev + 1) out.push("--");
			const focus = l.ranges?.[0];
			out.push(`${l.n}${l.match ? ":" : "-"}${clipLine(l.text, { focus })}`);
			prev = l.n;
		}
		if (file.hiddenMatchLines > 0) {
			const n = file.hiddenMatchLines;
			out.push(`[+${n} more matching ${plural(n, "line")} in this file]`);
		}
	}
	return out.join("\n");
}

// Layout of the body: `# repo` headings, files grouped by repo (first appearance), blank lines between.
const repoHeading = (repo: string) => `# ${repo}\n`;

function groupByRepo<T extends { repo: string }>(items: T[]): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const group = groups.get(item.repo);
		if (group) group.push(item);
		else groups.set(item.repo, [item]);
	}
	return groups;
}

/** Characters a block adds to the body; `newRepo` is given the first time its repo appears. */
function blockCost(block: string, newRepo?: string) {
	return (
		block.length +
		BLOCK_SEPARATOR.length +
		(newRepo === undefined ? 0 : repoHeading(newRepo).length)
	);
}

function layoutBody(entries: Array<{ repo: string; block: string }>) {
	return [...groupByRepo(entries)]
		.map(([repo, group]) => repoHeading(repo) + group.map((e) => e.block).join(BLOCK_SEPARATOR))
		.join(BLOCK_SEPARATOR);
}

export interface CapOptions {
	/** Defaults to the value `normalizeSearch` was given. */
	maxFiles?: number;
	/** Output budget in characters; defaults to `DEFAULT_OUTPUT_CHARS`. */
	maxChars?: number;
}

/**
 * Applies `maxFiles` and the output budget, renders every file block once (the first one is
 * hard-clipped if it alone exceeds the budget) and fills the truncation summary. Truncation is
 * only reported when something was actually left out.
 */
export function capSearch(model: SearchModel, options: CapOptions = {}): SearchModel {
	const maxFiles = options.maxFiles ?? model.limits.maxFiles;
	const maxChars = options.maxChars ?? model.limits.maxChars;
	const ranked = model.files.slice(0, maxFiles);
	const moreFiles = Math.max(0, model.totals.files - ranked.length);
	const withBranches = showBranches(ranked);

	const budget = Math.max(maxChars - FOOTER_RESERVE, 0);
	const files: SearchFile[] = [];
	const blocks: string[] = [];
	const repos = new Set<string>();
	let used = 0;
	let firstClipped = false;
	for (const file of ranked) {
		let block = renderFile(file, withBranches);
		if (files.length === 0) {
			const limit = Math.max(budget, MIN_FIRST_FILE_CHARS);
			firstClipped = block.length > limit;
			block = hardClip(block, limit);
		}
		const cost = blockCost(block, repos.has(file.repo) ? undefined : file.repo);
		if (files.length > 0 && used + cost > budget) break;
		files.push(file);
		blocks.push(block);
		repos.add(file.repo);
		used += cost;
	}
	const filesOmittedByBudget = ranked.length - files.length;

	const hiddenMatchLines = files.reduce((n, f) => n + f.hiddenMatchLines, 0);
	const reasons: SearchModel["truncation"]["reasons"] = [];
	if (moreFiles > 0) reasons.push("maxFiles");
	if (hiddenMatchLines > 0) reasons.push("maxMatchesPerFile");
	if (filesOmittedByBudget > 0 || firstClipped) reasons.push("outputBudget");
	return {
		...model,
		files,
		blocks,
		truncated: reasons.length > 0,
		truncation: { reasons, moreFiles, hiddenMatchLines, filesOmittedByBudget },
		limits: { ...model.limits, maxFiles, maxChars },
	};
}

function renderFooter(model: SearchModel) {
	const { totals, truncation, files, limits } = model;
	const atLeast = totals.filesIsLowerBound ? "at least " : "";
	const count = (n: number, noun: string) => `${n} ${plural(n, noun)}`;

	if (!model.truncated) {
		const filenameMatches = files.filter((f) => f.filenameMatch).length;
		const lines = Math.max(totals.matches - filenameMatches, 0);
		const parts = [`${totals.filesIsLowerBound ? "At least " : ""}${count(totals.files, "file")}`];
		if (lines > 0 || filenameMatches === 0) parts.push(count(lines, "matching line"));
		if (filenameMatches > 0)
			parts.push(`${filenameMatches} filename ${plural(filenameMatches, "match", "matches")}`);
		return `${parts.join(", ")}.`;
	}

	const shown = files.length;
	const ranked = shown + truncation.filesOmittedByBudget;
	const has = (reason: SearchModel["truncation"]["reasons"][number]) =>
		truncation.reasons.includes(reason);
	// The budget clause carries the lower bound only when it is the one that counts the files.
	const budgetCarriesBound = truncation.moreFiles === 0;

	const clauses: string[] = [];
	if (has("maxFiles")) {
		clauses.push(`showing ${shown} of ${atLeast}${totals.files} files`);
	}
	if (has("maxMatchesPerFile")) {
		const n = truncation.hiddenMatchLines;
		const cap = Number.isFinite(limits.maxMatchesPerFile) ? `=${limits.maxMatchesPerFile}` : "";
		clauses.push(`${count(n, "more matching line")} hidden by maxMatchesPerFile${cap}`);
	}
	if (has("outputBudget")) {
		const lead = budgetCarriesBound ? atLeast : "";
		clauses.push(
			`output budget (${limits.maxChars} chars) reached after ${shown} of ${lead}${count(ranked, "file")}`,
		);
	}
	const boundShown = has("maxFiles") || (has("outputBudget") && budgetCarriesBound);
	if (totals.filesIsLowerBound && !boundShown) {
		clauses.push(`at least ${count(totals.files, "file")} matched`);
	}
	return `Truncated: ${clauses.join("; ")}. Refine with repo:, file:, lang: or -file: filters, or raise maxFiles / maxMatchesPerFile.`;
}

/** The text a client sees, from a model that went through `capSearch`; see the tool description. */
export function renderSearchText(model: SearchModel): string {
	if (model.files.length === 0) return `No matches for \`${model.query}\`.`;
	const entries = model.files.map((f, i) => ({ repo: f.repo, block: model.blocks[i] ?? "" }));
	return `${layoutBody(entries)}${BLOCK_SEPARATOR}${FOOTER_RULE}\n${renderFooter(model)}`;
}
