import { z } from "zod";
import {
	buildFileContent,
	DEFAULT_WINDOW_LINES,
	formatFileContent,
	MAX_FETCH_BYTES,
	MAX_OUTPUT_CHARS,
	MAX_WINDOW_LINES,
} from "../file-format.js";
import type { ZoektClient } from "../zoekt/client.js";
import {
	ZoektAmbiguousFileError,
	ZoektFileNotFoundError,
	ZoektFileNotIndexedError,
} from "../zoekt/errors.js";
import { exactRepoAtom } from "../zoekt/query.js";
import type { FileContent, RepoListWire } from "../zoekt/types.js";
import type { ToolContext, ToolResult } from "./result.js";

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

export const readFileDescription = `Read a file from an indexed repository as numbered lines (\`N:text\`).

Returns at most ${DEFAULT_WINDOW_LINES} lines by default (up to ${MAX_WINDOW_LINES} with \`endLine\`) and ${MAX_OUTPUT_CHARS.toLocaleString("en-US")} characters per call; lines over 2000 characters are clipped. When the output is cut, the footer gives the \`startLine\` to continue with. Only text files that Zoekt indexed can be read (binary and oversized files are not indexed).

### Parameters
- \`repo\`, \`path\`: from \`search\` results (\`# <repo>\` and \`## <path>\`) or \`list_repos\`
- \`branch\`: optional indexed branch name. Zoekt matches it as a case-sensitive substring, so \`main\` can also match \`main-old\`; if that makes the file ambiguous, the error lists the branches
- \`startLine\`, \`endLine\`: optional line range (1-based, inclusive)

### Examples
- \`{ "repo": "github.com/org/repo", "path": "src/main.ts" }\`
- \`{ "repo": "github.com/org/repo", "path": "src/main.ts", "startLine": 501, "endLine": 700 }\`
- \`{ "repo": "github.com/org/repo", "path": "README.md", "branch": "develop" }\``;

/** `a/b`, `/a/b` and `./a/b` all mean `a/b`. */
function cleanPath(path: string): string {
	return path.replace(/^(?:\.?\/)+/, "");
}

const branchNames = (wire: RepoListWire) => wire.Repos[0]?.Branches.map((b) => b.Name) ?? [];

export async function executeReadFile(
	client: ZoektClient,
	input: ReadFileInput,
	ctx: ToolContext,
): Promise<ToolResult<FileContent>> {
	const { repo, branch, startLine } = input;
	const path = cleanPath(input.path);
	const endLine = input.endLine ?? startLine + DEFAULT_WINDOW_LINES - 1;
	if (path === "") throw new Error("path must not be empty.");
	if (endLine < startLine) {
		throw new Error(`endLine (${endLine}) must not be before startLine (${startLine}).`);
	}
	const req = { signal: ctx.signal };
	const lookupRepo = () =>
		client.listRepos(exactRepoAtom(repo), {}, req).then((wire) => ({
			...wire,
			Repos: wire.Repos.filter((r) => r.Name === repo),
		}));

	// `HEAD` is special-cased by Zoekt (the default branch); any other name is checked first because
	// /print would silently match it as a substring.
	let known: RepoListWire | undefined;
	if (branch !== undefined && branch !== "HEAD") {
		known = await lookupRepo();
		if (known.Repos.length === 0) throw repoNotFound(repo);
		const names = branchNames(known);
		if (!names.includes(branch)) {
			throw new Error(
				`Branch "${branch}" is not indexed for ${repo}. Indexed branches: ${names.join(", ") || "(none)"}.`,
			);
		}
	}

	let printed: Awaited<ReturnType<ZoektClient["print"]>>;
	try {
		printed = await client.print(repo, path, branch, { maxBytes: MAX_FETCH_BYTES }, req);
	} catch (error) {
		if (error instanceof ZoektFileNotFoundError) {
			known ??= await lookupRepo();
			if (known.Repos.length === 0) throw repoNotFound(repo);
			throw new Error(
				`File not found: ${repo}:${path}${branch ? ` (branch ${branch})` : ""}. The path must be exact and relative to the repository root; use search with \`f:\` to find it.`,
			);
		}
		if (error instanceof ZoektAmbiguousFileError) {
			known ??= await lookupRepo();
			const names = branchNames(known);
			const listing = `Indexed branches: ${names.join(", ") || "(unknown)"}.`;
			throw new Error(
				branch
					? `Multiple indexed versions of ${repo}:${path} match branch "${branch}" (Zoekt matches branch names as substrings, so "main" also matches "main-old"). Pass a more specific branch. ${listing}`
					: `Multiple indexed versions of ${repo}:${path} exist (content differs between branches). Pass branch. ${listing}`,
			);
		}
		if (error instanceof ZoektFileNotIndexedError) {
			const why =
				error.reason === "binary"
					? "binary content"
					: error.reason === "too-large"
						? "larger than the indexer's size limit"
						: error.detail;
			throw new Error(
				`File is not indexed by Zoekt (${why}): ${repo}:${path}. read_file returns indexed text files only.`,
			);
		}
		throw error;
	}

	const { file, clamped } = buildFileContent(printed.bytes, printed.truncated, {
		repo,
		path,
		branch,
		startLine,
		endLine,
	});
	return {
		text: formatFileContent(file, { clamped }),
		data: file,
		summary: {
			repo,
			path,
			lines: Math.max(0, file.endLine - file.startLine + 1),
			totalLines: file.totalLines,
		},
	};
}

function repoNotFound(repo: string): Error {
	return new Error(
		`Repository not found: ${repo}. Use list_repos to find the exact repository name.`,
	);
}
