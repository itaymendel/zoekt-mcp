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

function normalizeFile(file: FileMatch, { contextLines }: NormalizeOptions): SearchFile {
	const filenameMatch = file.Matches.some((m) => m.LineNum === 0);
	const content = file.Matches.filter((m) => m.LineNum > 0);

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

	const out: SearchFile = {
		repo: file.Repo,
		path: file.FileName,
		branches: file.Branches,
		filenameMatch,
		lines: [...byLine.values()].sort((a, b) => a.n - b.n),
		hiddenMatchLines: 0,
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
