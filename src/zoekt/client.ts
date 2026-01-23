import type { Logger } from "../logger.js";
import { type SearchOptions, type SearchResponse, SearchResponseSchema } from "./types.js";

export interface ZoektClientOptions {
	baseUrl: string;
	timeoutMs: number;
	logger: Logger;
	fetch?: typeof fetch;
}

export class ZoektClient {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly logger: Logger;
	private readonly fetchFn: typeof fetch;

	constructor(options: ZoektClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/$/, "");
		this.timeoutMs = options.timeoutMs;
		this.logger = options.logger.child({ component: "zoekt-client" });
		this.fetchFn = options.fetch ?? fetch;
	}

	async search({ query, num, contextLines }: SearchOptions): Promise<SearchResponse> {
		const searchParams = buildParams({ q: query, num, ctx: contextLines, format: "json" });
		const url = `${this.baseUrl}/search?${searchParams}`;

		this.logger.debug({ url: `search?${searchParams}` }, "Fetching from Zoekt");

		const response = await this.fetchFn(url, {
			signal: AbortSignal.timeout(this.timeoutMs),
			headers: { Accept: "application/json" },
		});

		if (!response.ok) {
			throw new Error(`Zoekt search failed: ${response.status} ${response.statusText}`);
		}

		const data = await response.json();
		const parsed = SearchResponseSchema.parse(data);

		this.logger.debug(
			{ query, fileCount: parsed.result.FileMatches?.length ?? 0 },
			"Search completed",
		);

		return parsed;
	}

	async getFileContent(repository: string, filePath: string, branch?: string): Promise<string> {
		const searchParams = buildParams({ r: repository, f: filePath, b: branch, format: "raw" });
		const url = `${this.baseUrl}/print?${searchParams}`;

		this.logger.debug({ url: `print?${searchParams}` }, "Fetching file from Zoekt");

		const response = await this.fetchFn(url, {
			signal: AbortSignal.timeout(this.timeoutMs),
			headers: { Accept: "text/plain" },
		});

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error(`File not found: ${repository}/${filePath}`);
			}
			throw new Error(`Zoekt print failed: ${response.status} ${response.statusText}`);
		}

		const content = await response.text();
		this.logger.debug(
			{ repository, filePath, branch, bytes: content.length },
			"File content retrieved",
		);
		return content;
	}

	async listRepositories(filter?: string): Promise<SearchResponse> {
		const query = filter ? `type:repo ${filter}` : "type:repo";
		return this.search({ query, num: 1000 });
	}
}

function buildParams(params: Record<string, string | number | undefined>): URLSearchParams {
	const result = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			result.set(key, String(value));
		}
	}
	return result;
}
