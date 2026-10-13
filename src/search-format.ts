import type {
	FileMatch,
	Match,
	SearchFile,
	SearchLine,
	SearchModel,
	SearchResponse,
} from "./zoekt/types.js";

export interface NormalizeOptions {
	query: string;
	/** Context lines to keep on each side of a match (Zoekt already limits them via `ctx`). */
	contextLines: number;
	/** Matching lines kept per file, in Zoekt's (score) order; context excluded. */
	maxMatchesPerFile?: number;
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
	return rows.map((r) => (r.endsWith("\r") ? r.slice(0, -1) : r));
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
	if (contextLines > 0) {
		for (const m of content) {
			const before = contextRows(m.Before).slice(-contextLines);
			before.forEach((text, i) => {
				const n = m.LineNum - before.length + i;
				if (n >= 1 && !byLine.has(n)) byLine.set(n, { n, text, match: false });
			});
			contextRows(m.After)
				.slice(0, contextLines)
				.forEach((text, i) => {
					const n = m.LineNum + 1 + i;
					if (!byLine.has(n)) byLine.set(n, { n, text, match: false });
				});
		}
	}

	// Hidden lines that already appear as context are not hidden.
	const kept = new Set(content.map((m) => m.LineNum));
	const hiddenMatchLines = new Set(
		all.filter((m) => !kept.has(m.LineNum) && !byLine.has(m.LineNum)).map((m) => m.LineNum),
	).size;

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

/** Zoekt answer -> model. Pure; no truncation is applied here (see `capSearch`). */
export function normalizeSearch(response: SearchResponse, opts: NormalizeOptions): SearchModel {
	const { FileMatches, Stats } = response.result;
	const files = FileMatches.map((f) => normalizeFile(f, opts));
	const matchLines = files.reduce((n, f) => n + f.lines.filter((l) => l.match).length, 0);
	return {
		query: opts.query,
		files,
		totals: {
			files: Math.max(Stats?.FileCount ?? 0, files.length),
			filesIsLowerBound: (Stats?.FilesSkipped ?? 0) > 0 || (Stats?.ShardsSkipped ?? 0) > 0,
			matches: Stats?.MatchCount || matchLines,
		},
		truncated: false,
		truncation: { reasons: [], moreFiles: 0, hiddenMatchLines: 0, filesOmittedByBudget: 0 },
		durationMs: Math.round((Stats?.Duration ?? 0) / 1e6),
	};
}

/** Output budget in characters for one `search` result (footer included, give or take the reserve). */
export const DEFAULT_OUTPUT_CHARS = 20_000;
/** Characters kept free for the footer when files are packed into the budget. */
export const FOOTER_RESERVE = 600;
/** A single row is clipped to this many characters (ellipses included). */
export const MAX_LINE_CHARS = 240;
/** The first file is always shown, even when the budget is smaller than this. */
const MIN_FIRST_FILE_CHARS = 200;
/** Separates the results from the footer. */
export const FOOTER_RULE = "---";

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** `text` cut to `max` characters around the first of `ranges` (or the start), never splitting a surrogate pair. */
export function clipLine(text: string, ranges?: Array<[number, number]>, max = MAX_LINE_CHARS) {
	if (text.length <= max) return text;
	const body = max - 2; // room for a leading and a trailing ellipsis
	const [from, to] = ranges?.[0] ?? [0, 0];
	const matchLen = Math.min(Math.max(to - from, 0), body);
	let start = Math.max(0, from - Math.floor((body - matchLen) / 2));
	let end = start + body;
	if (end > text.length) {
		end = text.length;
		start = Math.max(0, end - body);
	}
	if (start > 0 && isLow(text.charCodeAt(start))) start++;
	if (end < text.length && isHigh(text.charCodeAt(end - 1))) end--;
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export interface CapOptions {
	maxFiles: number;
	/** Output budget in characters; defaults to `DEFAULT_OUTPUT_CHARS`. */
	maxChars?: number;
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
			out.push(`${l.n}${l.match ? ":" : "-"}${clipLine(l.text, l.ranges)}`);
			prev = l.n;
		}
		if (file.hiddenMatchLines > 0) {
			const n = file.hiddenMatchLines;
			out.push(`[+${n} more matching ${plural(n, "line")} in this file]`);
		}
	}
	return out.join("\n");
}

/**
 * Applies `maxFiles` and the output budget, and fills the truncation summary. Truncation is only
 * reported when something was actually left out.
 */
export function capSearch(
	model: SearchModel,
	{ maxFiles, maxChars = DEFAULT_OUTPUT_CHARS }: CapOptions,
): SearchModel {
	const ranked = model.files.slice(0, maxFiles);
	const moreFiles = Math.max(0, model.totals.files - ranked.length);
	const withBranches = showBranches(ranked);

	const budget = Math.max(maxChars - FOOTER_RESERVE, 0);
	const files: SearchFile[] = [];
	const repos = new Set<string>();
	let used = 0;
	let firstClipped = false;
	for (const file of ranked) {
		// block + blank line, plus the `# repo` heading the first time a repo appears
		const size = renderFile(file, withBranches).length;
		const cost = size + 2 + (repos.has(file.repo) ? 0 : file.repo.length + 4);
		if (files.length === 0) {
			firstClipped = size > Math.max(budget, MIN_FIRST_FILE_CHARS);
		} else if (used + cost > budget) {
			break;
		}
		files.push(file);
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
		truncated: reasons.length > 0,
		truncation: { reasons, moreFiles, hiddenMatchLines, filesOmittedByBudget },
	};
}

export interface RenderOptions {
	/** Same budget given to `capSearch`; named in the footer and used to clip the first file. */
	maxChars?: number;
	/** Named in the footer when matching lines were hidden. */
	maxMatchesPerFile?: number;
}

function renderFooter(
	model: SearchModel,
	{ maxChars, maxMatchesPerFile }: Required<RenderOptions>,
) {
	const { totals, truncation, files } = model;
	const bound = totals.filesIsLowerBound ? "at least " : "";
	if (!model.truncated) {
		const lead = totals.filesIsLowerBound ? "At least " : "";
		return `${lead}${totals.files} ${plural(totals.files, "file")}, ${totals.matches} matching ${plural(totals.matches, "line")}.`;
	}
	const parts: string[] = [];
	// When only the budget left files out, its own clause below carries the counts.
	const onlyBudgetOmitted = truncation.filesOmittedByBudget > 0 && truncation.moreFiles === 0;
	if (files.length < totals.files && !onlyBudgetOmitted) {
		parts.push(`showing ${files.length} of ${bound}${totals.files} files`);
	}
	if (truncation.hiddenMatchLines > 0) {
		const n = truncation.hiddenMatchLines;
		const cap = Number.isFinite(maxMatchesPerFile) ? `=${maxMatchesPerFile}` : "";
		parts.push(`${n} more matching ${plural(n, "line")} hidden by maxMatchesPerFile${cap}`);
	}
	if (truncation.reasons.includes("outputBudget")) {
		const of = files.length + truncation.filesOmittedByBudget;
		const lead = truncation.moreFiles === 0 ? bound : "";
		parts.push(
			`output budget (${maxChars} chars) reached after ${files.length} of ${lead}${of} files`,
		);
	}
	return `Truncated: ${parts.join("; ")}. Refine with repo:, file:, lang: or -file: filters, or raise maxFiles / maxMatchesPerFile.`;
}

/** Truncates `s` to `max` characters without leaving half of a surrogate pair. */
function hardClip(s: string, max: number) {
	if (s.length <= max) return s;
	const end = isHigh(s.charCodeAt(max - 1)) ? max - 1 : max;
	return `${s.slice(0, end)}\n[output truncated]`;
}

/** The text a client sees; see the tool description for the layout. */
export function renderSearchText(model: SearchModel, options: RenderOptions = {}): string {
	const maxChars = options.maxChars ?? DEFAULT_OUTPUT_CHARS;
	const maxMatchesPerFile = options.maxMatchesPerFile ?? Number.POSITIVE_INFINITY;
	if (model.files.length === 0) return `No matches for \`${model.query}\`.`;

	const withBranches = showBranches(model.files);
	const byRepo = new Map<string, SearchFile[]>();
	for (const f of model.files) {
		const group = byRepo.get(f.repo);
		if (group) group.push(f);
		else byRepo.set(f.repo, [f]);
	}

	const firstLimit = Math.max(maxChars - FOOTER_RESERVE, MIN_FIRST_FILE_CHARS);
	const blocks: string[] = [];
	for (const [repo, group] of byRepo) {
		const files = group.map((f) => {
			const block = renderFile(f, withBranches);
			return f === model.files[0] ? hardClip(block, firstLimit) : block;
		});
		blocks.push(`# ${repo}\n${files.join("\n\n")}`);
	}
	const footer = renderFooter(model, { maxChars, maxMatchesPerFile });
	return `${blocks.join("\n\n")}\n\n${FOOTER_RULE}\n${footer}`;
}
