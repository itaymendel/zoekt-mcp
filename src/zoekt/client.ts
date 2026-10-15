import type { Logger } from "../logger.js";
import { redactUrl } from "../utils.js";
import {
	notIndexedReason,
	ZoektAmbiguousFileError,
	ZoektError,
	ZoektFileNotFoundError,
	ZoektQueryError,
} from "./errors.js";
import {
	ApiResponseSchema,
	type RepoListWire,
	type SearchOptions,
	type SearchResponse,
} from "./types.js";

/** Longest Zoekt error body quoted in an error message. */
const MAX_ERROR_BODY = 500;
/** Longest /search response read; Zoekt bounds it by `num`, so hitting this means something is wrong. */
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
/** Never read more than this from an error response. */
const MAX_ERROR_READ_BYTES = 64 * 1024;
/** Longest non-JSON 200 body quoted in an error message. */
const MAX_SNIPPET = 200;
/** Zoekt's `NOT-INDEXED: <reason>` stub for binary/oversized files is far below this. */
const NOT_INDEXED_MAX_BYTES = 256;
const HTML_HINT = "HTML page; is ZOEKT_URL pointing at zoekt-webserver?";
const utf8 = new TextDecoder();

interface ZoektClientOptions {
	baseUrl: string;
	timeoutMs: number;
	logger: Logger;
	fetch?: typeof fetch;
}

/** Per-call options; `signal` cancels the upstream Zoekt request. */
interface RequestOptions {
	signal?: AbortSignal;
}

/** A response body, cut off at the byte cap when `truncated`. */
interface Body {
	bytes: Uint8Array;
	truncated: boolean;
}

export class ZoektClient {
	/** Credential-free base URL (no trailing slash). */
	private readonly baseUrl: string;
	/** `Authorization` built once from userinfo in the configured URL, if any. */
	private readonly baseHeaders: Record<string, string> = {};
	private readonly timeoutMs: number;
	private readonly logger: Logger;
	private readonly fetchFn: typeof fetch;

	constructor(options: ZoektClientOptions) {
		// Node's fetch throws (echoing the password) for URLs with userinfo, so move it to a header.
		const url = new URL(options.baseUrl);
		if (url.username || url.password) {
			// config.ts has already rejected bad percent-encoding.
			const user = decodeURIComponent(url.username);
			const pass = decodeURIComponent(url.password);
			this.baseHeaders.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
			url.username = "";
			url.password = "";
		}
		this.baseUrl = url.href.replace(/\/$/, "");
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
			throw new ZoektError(
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
	async listRepos(rawQuery: string, num?: number, req: RequestOptions = {}): Promise<RepoListWire> {
		const data = await this.searchEndpoint({ q: rawQuery, num, order: "name" }, req);
		if (!data.repos) {
			throw new ZoektError(
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
		maxBytes?: number,
		req: RequestOptions = {},
	): Promise<Body> {
		const raw = await this.request(
			"print",
			{ r: repo, f: path, b: branch, format: "raw" },
			"text/plain",
			req,
			maxBytes,
		);

		if (!raw.truncated && raw.bytes.length <= NOT_INDEXED_MAX_BYTES) {
			const why = notIndexedReason(utf8.decode(raw.bytes));
			if (why !== undefined) {
				throw new ZoektError(`File is not indexed by Zoekt (${why}): ${repo}:${path}`);
			}
		}

		this.logger.debug(
			{ repo, path, branch, bytes: raw.bytes.length, truncated: raw.truncated },
			"File content retrieved",
		);
		return { bytes: raw.bytes, truncated: raw.truncated };
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
			MAX_SEARCH_BYTES,
		);
		if (raw.truncated) {
			throw new ZoektError(
				`Zoekt /search response exceeded ${MAX_SEARCH_BYTES / 1024 / 1024} MiB; narrow the query`,
			);
		}

		const text = utf8.decode(raw.bytes);
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			throw new ZoektError(
				`Zoekt /search returned a non-JSON response (content-type: ${raw.contentType || "none"}): ${text.slice(0, MAX_SNIPPET)}`,
			);
		}

		const parsed = ApiResponseSchema.safeParse(json);
		if (!parsed.success) {
			const issues = parsed.error.issues
				.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
				.join("; ");
			throw new ZoektError(`Zoekt /search returned an unexpected response: ${issues}`);
		}
		return parsed.data;
	}

	/**
	 * The only `fetch` call site: applies the timeout, merges the caller's signal, reads the body
	 * and classifies the status. Returns 2xx answers and throws for everything else; Zoekt's 418
	 * handler errors map to a specific error where the caller can act on them.
	 */
	private async request(
		endpoint: "search" | "print",
		params: Record<string, string | number | undefined>,
		accept: string,
		req: RequestOptions,
		maxBytes?: number,
	): Promise<Body & { contentType: string }> {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) search.set(key, String(value));
		}
		const query = search.toString();
		const path = query ? `${endpoint}?${query}` : endpoint;
		const url = `${this.baseUrl}/${path}`;
		this.logger.debug({ url: path }, "Fetching from Zoekt");

		const timeout = AbortSignal.timeout(this.timeoutMs);
		const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

		let response: Response;
		let body: Body;
		try {
			response = await this.fetchFn(url, {
				signal,
				headers: { ...this.baseHeaders, Accept: accept },
			});
			body = await readBody(response, response.ok ? maxBytes : MAX_ERROR_READ_BYTES);
		} catch (error) {
			if (req.signal?.aborted) throw error;
			if ((error as { name?: unknown } | null)?.name === "TimeoutError") {
				throw new ZoektError(`Zoekt request timed out after ${this.timeoutMs}ms`, { cause: error });
			}
			// undici puts the errno on `cause`.
			const code = [error, (error as { cause?: unknown } | null)?.cause]
				.map((e) => (e as { code?: unknown } | null)?.code)
				.find((c): c is string => typeof c === "string");
			if (code) {
				throw new ZoektError(`Cannot reach Zoekt at ${redactUrl(this.baseUrl)} (${code})`, {
					cause: error,
				});
			}
			throw error;
		}

		const contentType = response.headers.get("content-type") ?? "";
		const isHtml = /text\/html/i.test(contentType);
		if (response.ok) {
			if (isHtml) throw new ZoektError(`Zoekt /${endpoint} returned an ${HTML_HINT}`);
			return { contentType, ...body };
		}

		const text = utf8.decode(body.bytes);
		const shown = isHtml ? `<${HTML_HINT}>` : capBody(text);
		this.logger.debug({ status: response.status, body: text }, "Zoekt returned an error");
		if (response.status === 418) {
			if (endpoint === "search")
				throw new ZoektQueryError(`Zoekt rejected the request${shown ? `: ${shown}` : ""}`);
			const listed = /^ambiguous result: \[(.*)\]/s.exec(text.trim());
			if (listed) {
				const { r, f, b } = params;
				throw (listed[1] ?? "").trim() === ""
					? new ZoektFileNotFoundError(
							`File not found in index: ${r}:${f}${b ? ` (branch ${b})` : ""}`,
						)
					: new ZoektAmbiguousFileError(
							`Multiple indexed versions of ${r}:${f} exist (content differs between branches). Pass a branch.`,
						);
			}
		}
		throw new ZoektError(
			`Zoekt /${endpoint} failed: HTTP ${response.status} ${response.statusText}${shown ? `: ${shown}` : ""}`,
		);
	}
}

async function readBody(response: Response, maxBytes?: number): Promise<Body> {
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

/** Trimmed, capped body for error messages. */
function capBody(body: string): string {
	return body.trim().slice(0, MAX_ERROR_BODY);
}
