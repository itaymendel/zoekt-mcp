import { z } from "zod";
import {
	DEFAULT_WINDOW_LINES,
	formatFile,
	MAX_FETCH_BYTES,
	MAX_OUTPUT_CHARS,
	MAX_WINDOW_LINES,
	resolveRange,
} from "../file-format.js";
import { READ_ONLY_ANNOTATIONS } from "../instructions.js";
import type { ZoektClient } from "../zoekt/client.js";
import {
	ZoektAmbiguousFileError,
	ZoektFileNotFoundError,
	ZoektFileNotIndexedError,
} from "../zoekt/errors.js";
import { exactRepoAtom } from "../zoekt/query.js";

export const readFileSchema = z.object({
	repo: z.string().min(1).describe("Exact repository name, as shown by list_repos or search"),
	path: z
		.string()
		.min(1)
		.describe("File path within the repository (a leading '/' or './' is ignored)"),
	branch: z
		.string()
		.optional()
		.describe("Indexed branch name (default: the repository's default branch)"),
	startLine: z.number().int().min(1).default(1).describe("First line to return (1-based)"),
	endLine: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(`Last line to return (default: startLine + ${DEFAULT_WINDOW_LINES - 1})`),
});

export type ReadFileInput = z.infer<typeof readFileSchema>;

export const readFileMeta = { title: "Read file", annotations: READ_ONLY_ANNOTATIONS };

export const readFileDescription = `Read a file from an indexed repository as numbered lines (\`N:text\`).

\`repo\` and \`path\` are exactly as search prints them (\`# <repo>\`, \`## <path>\`). \`startLine\` and \`endLine\` are 1-based and inclusive. The default is ${DEFAULT_WINDOW_LINES} lines, the maximum ${MAX_WINDOW_LINES}, and output is capped at ${MAX_OUTPUT_CHARS.toLocaleString("en-US")} characters; when cut, the footer gives the \`startLine\` to continue from.

\`branch\` is an exact indexed branch name, or \`HEAD\` for the default branch. Omit it for the default branch; a file that differs between branches needs it.

Binary and oversized files are not indexed and cannot be read (NOT-INDEXED).`;

/** `a/b`, `/a/b` and `./a/b` all mean `a/b`. */
function cleanPath(path: string): string {
	return path.replace(/^(?:\.?\/)+/, "");
}

const NOT_INDEXED_WHY: Record<string, string> = {
	binary: "binary content",
	"too-large": "larger than the indexer's size limit",
};

interface PrintFailure {
	repo: string;
	path: string;
	branch?: string;
	/** Indexed branch names of `repo` (default branch first); undefined when the repo is not indexed. */
	indexedBranches(): Promise<string[] | undefined>;
}

export async function executeReadFile(
	client: ZoektClient,
	input: ReadFileInput,
	ctx: { signal: AbortSignal },
): Promise<string> {
	const { repo, branch } = input;
	const path = cleanPath(input.path);
	if (path === "") throw new Error("path must not be empty.");
	const range = resolveRange(input.startLine, input.endLine);
	const req = { signal: ctx.signal };

	// One listRepos at most, shared by the branch check and any error explanation.
	let lookup: Promise<string[] | undefined> | undefined;
	const indexedBranches = () =>
		(lookup ??= client.listRepos(exactRepoAtom(repo), {}, req).then((wire) => {
			const entry = wire.Repos.find((r) => r.Name === repo);
			return entry?.Branches.map((b) => b.Name);
		}));

	// `HEAD` is special-cased by Zoekt (the default branch); any other name is checked first because
	// /print would silently match it as a substring.
	if (branch !== undefined && branch !== "HEAD") {
		const names = await indexedBranches();
		if (!names) throw repoNotFound(repo);
		if (!names.includes(branch)) {
			throw new Error(
				`Branch "${branch}" is not indexed for ${repo}. Indexed branches: ${names.join(", ") || "(none)"}.`,
			);
		}
	}

	// Zoekt /print has no range support, so every page re-fetches the file (up to MAX_FETCH_BYTES).
	let printed: Awaited<ReturnType<ZoektClient["print"]>>;
	try {
		printed = await client.print(repo, path, branch, { maxBytes: MAX_FETCH_BYTES }, req);
	} catch (error) {
		throw await explainPrintError(error, { repo, path, branch, indexedBranches });
	}

	return formatFile(printed.bytes, printed.truncated, { repo, path }, range);
}

/** The error to show for a failed /print: typed Zoekt errors get a specific message, others pass through. */
async function explainPrintError(error: unknown, ctx: PrintFailure): Promise<unknown> {
	const { repo, path, branch } = ctx;
	if (error instanceof ZoektFileNotFoundError) {
		const names = await ctx.indexedBranches();
		if (!names) return repoNotFound(repo);
		return new Error(
			`File not found: ${repo}:${path}${branch ? ` (branch ${branch})` : ""}. The path must be exact and relative to the repository root; use search with \`f:\` to find it.`,
		);
	}
	if (error instanceof ZoektAmbiguousFileError) {
		const names = (await ctx.indexedBranches()) ?? [];
		const listing = `Indexed branches: ${names.join(", ") || "(unknown)"}.`;
		const where = `Multiple indexed versions of ${repo}:${path}`;
		if (!branch) {
			return new Error(
				`${where} exist (content differs between branches). Pass branch. ${listing}`,
			);
		}
		const hint =
			branch === names[0]
				? `Pass branch: "HEAD" to read the default branch.`
				: "This is a known limitation: Zoekt matches branch names as substrings, so a branch whose name is contained in another branch's name cannot be selected on its own.";
		return new Error(`${where} match branch "${branch}". ${hint} ${listing}`);
	}
	if (error instanceof ZoektFileNotIndexedError) {
		const why = NOT_INDEXED_WHY[error.reason] ?? error.detail;
		return new Error(
			`File is not indexed by Zoekt (${why}): ${repo}:${path}. read_file returns indexed text files only.`,
		);
	}
	return error;
}

function repoNotFound(repo: string): Error {
	return new Error(
		`Repository not found: ${repo}. Use list_repos to find the exact repository name.`,
	);
}
