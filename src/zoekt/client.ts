import type { Logger } from "../logger.js";
import { redactUrl } from "../utils.js";
import {
	ZoektAmbiguousFileError,
	ZoektError,
	ZoektFileNotFoundError,
	ZoektFileNotIndexedError,
	ZoektHttpError,
	ZoektProtocolError,
	ZoektQueryError,
} from "./errors.js";
import {
	ApiResponseSchema,
	type ListReposOptions,
	type RepoListWire,
	type SearchOptions,
	type SearchResponse,
} from "./types.js";

/** Longest Zoekt error body quoted in an error message. */
export const MAX_ERROR_BODY = 500;
/** Longest non-JSON 200 body quoted in an error message. */
const MAX_SNIPPET = 200;
/** Never read more than this from an error response. */
const MAX_ERROR_READ_BYTES = 64 * 1024;
/** Zoekt's `NOT-INDEXED: <reason>` stub for binary/oversized files is far below this. */
const NOT_INDEXED_MAX_BYTES = 256;

export interface ZoektClientOptions {
	baseUrl: string;
	timeoutMs: number;
	logger: Logger;
	fetch?: typeof fetch;
}

/** Per-call options; `signal` cancels the upstream Zoekt request. */
export interface RequestOptions {
	signal?: AbortSignal;
}

export interface PrintOptions {
	/** Stop reading after this many bytes and report `truncated`. */
	maxBytes?: number;
}

export interface PrintResult {
	bytes: Uint8Array;
	truncated: boolean;
}

/** A successful (2xx) answer; non-2xx never leaves `request()`. */
interface RawResponse {
	contentType: string;
	isHtml: boolean;
	bytes: Uint8Array;
	truncated: boolean;
}

/** An error body, decoded once: the full text and the capped form used in messages. */
interface ErrorBody {
	text: string;
	shown: string;
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

	async search(
		{ query, num, contextLines }: SearchOptions,
		req: RequestOptions = {},
	): Promise<SearchResponse> {
		const data = await this.searchEndpoint({ q: query, num, ctx: contextLines }, req);
		if (!data.result) {
			throw new ZoektProtocolError(
				"Query was interpreted as a repository listing (it has only repo: filters); add a content term or use list_repos",
			);
		}
		this.logger.debug({ query, fileCount: data.result.FileMatches.length }, "Search completed");
		return { result: data.result };
	}

	/**
	 * Runs a repo-only query (see `repoListQuery`); Zoekt answers with the `{repos}` envelope.
	 * Live-verified: `order=name` sorts ascending before `num` truncates, `Stats.Repos` is the
	 * pre-`num` total, and an unknown `order` value is a 418.
	 */
	async listRepos(
		rawQuery: string,
		{ num }: ListReposOptions = {},
		req: RequestOptions = {},
	): Promise<RepoListWire> {
		const data = await this.searchEndpoint({ q: rawQuery, num, order: "name" }, req);
		if (!data.repos) {
			throw new ZoektProtocolError(
				`Zoekt returned file results; expected repository listing for query: ${rawQuery}`,
			);
		}
		return data.repos;
	}

	/**
	 * Fetches a file. `r` and `f` are exact; `b` is a literal, case-sensitive substring of the
	 * branch name with `HEAD` special-cased (branch-aware semantics are handled by the caller).
	 */
	async print(
		repo: string,
		path: string,
		branch?: string,
		opts: PrintOptions = {},
		req: RequestOptions = {},
	): Promise<PrintResult> {
		const raw = await this.request(
			"print",
			{ r: repo, f: path, b: branch, format: "raw" },
			"text/plain",
			req,
			{
				maxBytes: opts.maxBytes,
				on418: ({ text }) => {
					const listed = /^ambiguous result: \[(.*)\]/s.exec(text.trim());
					if (!listed) return undefined;
					const files = (listed[1] ?? "").split(/\s+/).filter(Boolean);
					return files.length === 0
						? new ZoektFileNotFoundError(repo, path, branch)
						: new ZoektAmbiguousFileError(repo, path, Math.max(2, files.length));
				},
			},
		);

		if (raw.isHtml) {
			throw new ZoektProtocolError(
				"Zoekt /print ignored format=raw and returned an HTML page; is ZOEKT_URL pointing at zoekt-webserver?",
			);
		}
		if (!raw.truncated && raw.bytes.length <= NOT_INDEXED_MAX_BYTES) {
			const stub = notIndexedFromStub(decode(raw.bytes), repo, path);
			if (stub) throw stub;
		}

		this.logger.debug(
			{ repo, path, branch, bytes: raw.bytes.length, truncated: raw.truncated },
			"File content retrieved",
		);
		return { bytes: raw.bytes, truncated: raw.truncated };
	}

	/** Thin text wrapper over `print` until branch-aware reads land. */
	async getFileContent(
		repository: string,
		filePath: string,
		branch?: string,
		req: RequestOptions = {},
	): Promise<string> {
		const { bytes } = await this.print(repository, filePath, branch, {}, req);
		return decode(bytes);
	}

	private async searchEndpoint(
		params: Record<string, string | number | undefined>,
		req: RequestOptions,
	) {
		const raw = await this.request(
			"search",
			{ ...params, format: "json" },
			"application/json",
			req,
			{
				on418: ({ shown }) =>
					new ZoektQueryError(`Zoekt rejected the request${shown ? `: ${shown}` : ""}`),
			},
		);

		const text = decode(raw.bytes);
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			throw new ZoektProtocolError(
				`Zoekt /search returned a non-JSON response (content-type: ${raw.contentType || "none"}): ${text.slice(0, MAX_SNIPPET)}`,
			);
		}

		const parsed = ApiResponseSchema.safeParse(json);
		if (!parsed.success) {
			const issues = parsed.error.issues
				.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
				.join("; ");
			throw new ZoektProtocolError(`Zoekt /search returned an unexpected response: ${issues}`);
		}
		return parsed.data;
	}

	/**
	 * The only `fetch` call site: applies the timeout, merges the caller's signal, reads the body
	 * and classifies the status. Returns 2xx answers and throws for everything else: `on418` may
	 * map Zoekt's 418 handler errors to a specific error, otherwise a `ZoektHttpError`.
	 */
	private async request(
		endpoint: "search" | "print",
		params: Record<string, string | number | undefined>,
		accept: string,
		req: RequestOptions,
		{ maxBytes, on418 }: { maxBytes?: number; on418?: (body: ErrorBody) => Error | undefined } = {},
	): Promise<RawResponse> {
		const query = buildParams(params);
		const url = `${this.baseUrl}/${endpoint}?${query}`;
		this.logger.debug({ url: `${endpoint}?${query}` }, "Fetching from Zoekt");

		const timeout = AbortSignal.timeout(this.timeoutMs);
		const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

		let response: Response;
		let body: { bytes: Uint8Array; truncated: boolean };
		try {
			response = await this.fetchFn(url, { signal, headers: { Accept: accept } });
			body = await readBody(response, response.ok ? maxBytes : MAX_ERROR_READ_BYTES);
		} catch (error) {
			throw this.mapFetchError(error, req.signal);
		}

		const contentType = response.headers.get("content-type") ?? "";
		const isHtml = /text\/html/i.test(contentType);
		if (response.ok) return { contentType, isHtml, ...body };

		const text = decode(body.bytes);
		const error: ErrorBody = { text, shown: formatBody(text, isHtml) };
		this.logger.debug({ status: response.status, body: text }, "Zoekt returned an error");
		if (response.status === 418) {
			const mapped = on418?.(error);
			if (mapped) throw mapped;
		}
		throw new ZoektHttpError(
			`Zoekt /${endpoint} failed: HTTP ${response.status} ${response.statusText}${error.shown ? `: ${error.shown}` : ""}`,
			response.status,
		);
	}

	private mapFetchError(error: unknown, callerSignal?: AbortSignal): unknown {
		if (callerSignal?.aborted) return error;
		if ((error as { name?: unknown } | null)?.name === "TimeoutError") {
			return new ZoektError(`Zoekt request timed out after ${this.timeoutMs}ms`, {
				cause: error,
			});
		}
		const code = networkCode(error);
		if (code) {
			return new ZoektError(`Cannot reach Zoekt at ${redactUrl(this.baseUrl)} (${code})`, {
				cause: error,
			});
		}
		return error;
	}
}

const NETWORK_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ECONNRESET",
	"EHOSTUNREACH",
]);
// ConnectionRefused -> ECONNREFUSED (Bun runtime; tests)
const CODE_ALIASES: Record<string, string> = { ConnectionRefused: "ECONNREFUSED" };

/** Finds a known network error code on the error or its `cause` chain (undici wraps in "fetch failed"). */
function networkCode(error: unknown): string | undefined {
	for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
		const code = (e as { code?: unknown }).code;
		if (typeof code === "string") {
			const known = CODE_ALIASES[code] ?? code;
			if (NETWORK_CODES.has(known)) return known;
		}
		e = (e as { cause?: unknown }).cause;
	}
	return undefined;
}

async function readBody(
	response: Response,
	maxBytes?: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (maxBytes === undefined || !response.body) {
		return { bytes: new Uint8Array(await response.arrayBuffer()), truncated: false };
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (total + value.length > maxBytes) {
			chunks.push(value.subarray(0, maxBytes - total));
			total = maxBytes;
			truncated = true;
			await reader.cancel();
			break;
		}
		chunks.push(value);
		total += value.length;
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return { bytes, truncated };
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

/** Trimmed, blank-run-collapsed, capped body for error messages; HTML pages are summarized. */
function formatBody(body: string, isHtml: boolean): string {
	if (isHtml) return "<HTML page; is ZOEKT_URL pointing at zoekt-webserver?>";
	const text = body.trim().replace(/\n\s*\n+/g, "\n");
	if (text.length <= MAX_ERROR_BODY) return text;
	return `${text.slice(0, MAX_ERROR_BODY)}… (truncated, ${text.length} chars total)`;
}

/** `[pattern, reason, detail]`: how Zoekt's `NOT-INDEXED: <why>` stub maps to a typed error. */
const NOT_INDEXED_REASONS: Array<[RegExp, "binary" | "too-large", string]> = [
	[/binary/i, "binary", "binary content"],
	[/size limit/i, "too-large", "larger than the indexer's size limit"],
];

function notIndexedFromStub(body: string, repo: string, path: string) {
	const why = /^NOT-INDEXED: (.+)$/.exec(body.trim())?.[1];
	if (why === undefined) return undefined;
	const hit = NOT_INDEXED_REASONS.find(([re]) => re.test(why));
	return hit
		? new ZoektFileNotIndexedError(repo, path, hit[1], hit[2])
		: new ZoektFileNotIndexedError(repo, path, "other", why);
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
