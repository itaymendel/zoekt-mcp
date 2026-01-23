import type { FileMatch, Match, SearchResponse } from "./zoekt/types.js";

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function formatSearchResultsAsText(response: SearchResponse): string {
	const files = response.result.FileMatches ?? [];
	if (files.length === 0) return "No matches found.";
	return files.map(formatFileMatch).join("\n");
}

function formatFileMatch(file: FileMatch): string {
	const header = `## ${file.Repo}/${file.FileName}`;
	const language = file.Language ? `Language: ${file.Language}` : "";
	const branches = file.Branches?.length ? `Branches: ${file.Branches.join(", ")}` : "";

	const matches = file.Matches ?? [];
	const formattedMatches = matches.map(formatMatch).filter(Boolean).join("\n");

	const parts = [header, language, branches].filter(Boolean);
	if (formattedMatches) {
		parts.push("", formattedMatches);
	}

	return `${parts.join("\n")}\n`;
}

function formatMatch(match: Match): string {
	const fragments = match.Fragments.map((f) => {
		const content = `${f.Pre}${f.Match}${f.Post}`.trim();
		return content ? `> ${match.LineNum}: ${content}` : "";
	})
		.filter(Boolean)
		.join("\n");
	return fragments;
}

interface RepoInfo {
	url?: string;
	branches?: string[];
}

export function formatRepositoriesAsText(response: SearchResponse): string {
	const { RepoURLs: repoUrls = {}, FileMatches: files } = response.result;
	const fileList = files ?? [];

	const repos = new Map<string, RepoInfo>(
		fileList.map((f) => [f.Repo, { url: repoUrls[f.Repo], branches: f.Branches ?? undefined }]),
	);

	for (const [name, url] of Object.entries(repoUrls)) {
		if (!repos.has(name)) repos.set(name, { url });
	}

	if (repos.size === 0) return "No repositories found.";

	const list = [...repos.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([name, repo]) => formatRepoEntry(name, repo))
		.join("\n");

	return `Found ${repos.size} repositories:\n\n${list}`;
}

function formatRepoEntry(name: string, { url, branches }: RepoInfo): string {
	const lines = [`- ${name}`];
	if (url) lines.push(`  URL: ${url}`);
	if (branches?.length) lines.push(`  Branches: ${branches.join(", ")}`);
	return lines.join("\n");
}

export function formatFileContentAsText(
	repository: string,
	filePath: string,
	content: string,
	branch?: string,
): string {
	const lineCount = content.split("\n").length;
	const basePath = `${repository}/${filePath}`;
	const location = branch ? `${basePath} (branch: ${branch})` : basePath;

	return `File: ${location}\nLines: ${lineCount}\n\n${content}`;
}
