import { z } from "zod";
import {
	DEFAULT_WINDOW_LINES,
	formatFile,
	MAX_FETCH_BYTES,
	MAX_OUTPUT_CHARS,
	MAX_WINDOW_LINES,
} from "../file-format.js";
import type { ZoektClient } from "../zoekt/client.js";
import { ZoektAmbiguousFileError, ZoektFileNotFoundError } from "../zoekt/errors.js";
import { exactRepoAtom } from "../zoekt/query.js";
import type { Tool } from "./tool.js";

const inputSchema = z.object({
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

const description = `Read a file from an indexed repository as numbered lines (\`N:text\`).

\`repo\` and \`path\` are exactly as search prints them (\`# <repo>\`, \`## <path>\`). \`startLine\` and \`endLine\` are 1-based and inclusive. The default is ${DEFAULT_WINDOW_LINES} lines, the maximum ${MAX_WINDOW_LINES}, and output is capped at ${MAX_OUTPUT_CHARS.toLocaleString("en-US")} characters; when cut, the footer gives the \`startLine\` to continue from.

\`branch\` is an exact indexed branch name, or \`HEAD\` for the default branch. Omit it for the default branch; a file that differs between branches needs it.

Binary and oversized files are not indexed and cannot be read (NOT-INDEXED).`;

/** `a/b`, `/a/b` and `./a/b` all mean `a/b`. */
function cleanPath(path: string): string {
	return path.replace(/^(?:\.?\/)+/, "");
}

async function readFile(
	client: ZoektClient,
	input: z.infer<typeof inputSchema>,
	ctx: { signal: AbortSignal },
): Promise<string> {
	const { repo, branch } = input;
	const path = cleanPath(input.path);
	if (path === "") throw new Error("path must not be empty.");
	const startLine = input.startLine;
	const wanted = input.endLine ?? startLine + DEFAULT_WINDOW_LINES - 1;
	if (wanted < startLine) {
		throw new Error(`endLine (${wanted}) must not be before startLine (${startLine}).`);
	}
	const range = { startLine, endLine: Math.min(wanted, startLine + MAX_WINDOW_LINES - 1) };
	const req = { signal: ctx.signal };

	// One listRepos at most, shared by the branch check and any error explanation.
	let lookup: Promise<string[] | undefined> | undefined;
	const indexedBranches = () =>
		(lookup ??= client.listRepos(exactRepoAtom(repo), undefined, req).then((wire) => {
			const entry = wire.Repos.find((r) => r.Name === repo);
			return entry?.Branches.map((b) => b.Name);
		}));

	// `HEAD` is special-cased by Zoekt (the default branch); any other name is checked first because
	// /print would silently match it as a substring.
	if (branch !== undefined && branch !== "HEAD") {
		const names = await indexedBranches();
		if (!names?.includes(branch)) {
			throw new Error(
				`Branch "${branch}" is not indexed for ${repo}. Indexed branches: ${names?.join(", ") || "(none; check the repository name with list_repos)"}.`,
			);
		}
	}

	// Zoekt /print has no range support, so every page re-fetches the file (up to MAX_FETCH_BYTES).
	let printed: Awaited<ReturnType<ZoektClient["print"]>>;
	try {
		printed = await client.print(repo, path, branch, MAX_FETCH_BYTES, req);
	} catch (error) {
		if (error instanceof ZoektFileNotFoundError) {
			throw new Error(
				`File not found: ${repo}:${path}${branch ? ` (branch ${branch})` : ""}. The path must be exact and relative to the repository root; use search with \`f:\` to find it, or list_repos to check the repository name.`,
			);
		}
		if (error instanceof ZoektAmbiguousFileError) {
			const names = (await indexedBranches()) ?? [];
			const listing = `Indexed branches: ${names.join(", ") || "(unknown)"}.`;
			const where = `Multiple indexed versions of ${repo}:${path}`;
			throw new Error(
				branch
					? `${where} match branch "${branch}". ${branch === names[0] ? `Pass branch: "HEAD" to read the default branch. ` : ""}${listing}`
					: `${where} exist (content differs between branches). Pass branch. ${listing}`,
			);
		}
		throw error;
	}

	return formatFile(printed.bytes, printed.truncated, { repo, path }, range);
}

export const readFileTool: Tool<typeof inputSchema> = {
	name: "read_file",
	title: "Read file",
	description,
	inputSchema,
	execute: readFile,
};
