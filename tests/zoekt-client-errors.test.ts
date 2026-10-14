import { describe, expect, test } from "bun:test";
import {
	ZoektAmbiguousFileError,
	ZoektFileNotFoundError,
	ZoektFileNotIndexedError,
} from "../src/zoekt/errors.js";
import { startFakeZoekt } from "./helpers/fake-zoekt.js";
import { ALPHA_REPO, DELTA_REPO } from "./helpers/fixture-repo.js";
import { hangingFetch } from "./helpers/hanging-fetch.js";
import { testDeps } from "./helpers/test-deps.js";
import { loadCase, mockZoektFetch } from "./helpers/zoekt-fixtures.js";

function clientWith(
	fetch: typeof globalThis.fetch,
	timeoutMs = 5000,
	baseUrl = "http://zoekt.test",
) {
	return testDeps(fetch, { baseUrl, timeoutMs }).client;
}

const stubResponse = (body: string, init: ResponseInit & { contentType?: string } = {}) => {
	const { contentType = "text/plain; charset=utf-8", ...rest } = init;
	return (async () =>
		new Response(body, {
			...rest,
			headers: { "Content-Type": contentType },
		})) as unknown as typeof fetch;
};

async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected promise to reject");
}

describe("C1 error bodies", () => {
	test.each([
		[
			"/search -> rejected query with Zoekt's text",
			() => clientWith(mockZoektFetch({ "/search": "search-error-parse" })).search({ query: "(" }),
			"Zoekt rejected the request: query: missing close paren, got token <nil>",
		],
		[
			"/print -> plain HTTP error",
			() =>
				clientWith(
					stubResponse("error parsing regexp: foo", { status: 418, statusText: "I'm a teapot" }),
				).print(ALPHA_REPO, "x"),
			"Zoekt /print failed: HTTP 418 I'm a teapot: error parsing regexp: foo",
		],
	])("418 %s", async (_name, call, message) => {
		const error = await rejection(call());

		expect(error.message).toBe(message);
	});

	test("5xx includes status, statusText and body", async () => {
		const client = clientWith(stubResponse("boom", { status: 502, statusText: "Bad Gateway" }));
		const error = await rejection(client.search({ query: "x" }));

		expect(error.message).toBe("Zoekt /search failed: HTTP 502 Bad Gateway: boom");
	});

	test("empty error body omits the suffix", async () => {
		const client = clientWith(stubResponse("", { status: 503, statusText: "Service Unavailable" }));
		const error = await rejection(client.search({ query: "x" }));

		expect(error.message).toBe("Zoekt /search failed: HTTP 503 Service Unavailable");
	});

	test("long error bodies are truncated with the total length", async () => {
		const failing = (n: number) =>
			rejection(
				clientWith(stubResponse("x".repeat(n), { status: 500, statusText: "ISE" })).search({
					query: "q",
				}),
			);

		expect((await failing(500)).message).toBe(
			`Zoekt /search failed: HTTP 500 ISE: ${"x".repeat(500)}`,
		);
		expect((await failing(600)).message).toBe(
			`Zoekt /search failed: HTTP 500 ISE: ${"x".repeat(500)}… (truncated, 600 chars total)`,
		);
	});

	test("an HTML error page is summarized, not dumped", async () => {
		const client = clientWith(
			stubResponse("<html><body>nginx</body></html>", {
				status: 502,
				statusText: "Bad Gateway",
				contentType: "text/html",
			}),
		);
		const error = await rejection(client.search({ query: "x" }));

		expect(error.message).toBe(
			"Zoekt /search failed: HTTP 502 Bad Gateway: <HTML page; is ZOEKT_URL pointing at zoekt-webserver?>",
		);
	});

	test("200 JSON of the wrong shape", async () => {
		const client = clientWith(stubResponse("{}", { contentType: "application/json" }));
		const error = await rejection(client.search({ query: "x" }));

		expect(error.message).toContain("neither 'result' nor 'repos'");
	});
});

describe("C3 abort and network errors", () => {
	const honoringSignal = hangingFetch().fetch;

	test("aborts when signal aborted", async () => {
		const client = clientWith(honoringSignal);
		const controller = new AbortController();
		const started = performance.now();
		const pending = rejection(client.search({ query: "x" }, { signal: controller.signal }));
		controller.abort();
		const error = await pending;

		expect(error.name).toBe("AbortError");
		expect(performance.now() - started).toBeLessThan(50);
	});

	test("times out", async () => {
		const error = await rejection(clientWith(honoringSignal, 30).search({ query: "x" }));

		expect(error.message).toBe("Zoekt request timed out after 30ms");
	});

	test.each([
		["undici-style cause", new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })],
		[
			"Bun-style ConnectionRefused",
			Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }),
		],
		[
			"any other errno or TLS code",
			new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } }),
		],
	])(
		"network error (%s) is reported with its code, credentials redacted",
		async (_name, thrown) => {
			const fail = (async () => {
				throw thrown;
			}) as unknown as typeof fetch;
			const error = await rejection(
				clientWith(fail, 5000, "http://user:secret@zoekt.test:6070").search({ query: "x" }),
			);

			expect(error.message).toMatch(
				/^Cannot reach Zoekt at http:\/\/zoekt\.test:6070 \((ECONNREFUSED|UND_ERR_SOCKET)\)$/,
			);
			expect(error.message).not.toContain("secret");
		},
	);

	test("a real refused connection reports ECONNREFUSED and the URL", async () => {
		const fake = await startFakeZoekt();
		const { url } = fake;
		await fake.close();
		const error = await rejection(
			testDeps(undefined, { baseUrl: url }).client.search({ query: "x" }),
		);

		expect(error.message).toBe(`Cannot reach Zoekt at ${url} (ECONNREFUSED)`);
	});

	test("a real unanswered request times out", async () => {
		const fake = await startFakeZoekt({ hang: true });
		try {
			const { client } = testDeps(undefined, { baseUrl: fake.url, timeoutMs: 100 });
			const error = await rejection(client.search({ query: "x" }));

			expect(error.message).toBe("Zoekt request timed out after 100ms");
		} finally {
			await fake.close();
		}
	});
});

describe("C4 /print mapping", () => {
	const printClient = (route: string) => clientWith(mockZoektFetch({ "/print": route }));

	test("print-ok returns bytes; format=raw sent; no b when branch undefined", async () => {
		const fetch = mockZoektFetch({ "/print": "print-ok" });
		const client = clientWith(fetch);
		const { bytes, truncated } = await client.print(ALPHA_REPO, "docs/notes.txt");

		expect(new TextDecoder().decode(bytes)).toBe(loadCase("print-ok").response.bodyText as string);
		expect(truncated).toBe(false);
		const params = fetch.requests[0]?.searchParams;
		expect(params?.get("format")).toBe("raw");
		expect(params?.has("b")).toBe(false);
		expect(params?.get("r")).toBe(ALPHA_REPO);
		expect(params?.get("f")).toBe("docs/notes.txt");
	});

	test("print-not-found -> ZoektFileNotFoundError", async () => {
		const error = await rejection(printClient("print-not-found").print(ALPHA_REPO, "nope.txt"));

		expect(error).toBeInstanceOf(ZoektFileNotFoundError);
		expect(error.message).toBe("File not found in index: example.test/alpha:nope.txt");
	});

	test("not-found message names the branch", async () => {
		const error = await rejection(
			printClient("print-not-found").print(ALPHA_REPO, "nope.txt", "dev"),
		);

		expect(error.message).toBe("File not found in index: example.test/alpha:nope.txt (branch dev)");
	});

	test("print-ambiguous -> ZoektAmbiguousFileError", async () => {
		const error = await rejection(printClient("print-ambiguous").print(ALPHA_REPO, "Makefile"));

		expect(error).toBeInstanceOf(ZoektAmbiguousFileError);
		expect(error.message).toContain("Pass a branch.");
	});

	test.each([
		[
			"binary",
			() => printClient("print-not-indexed-binary"),
			DELTA_REPO,
			"bin.dat",
			"binary content",
		],
		[
			"too large",
			() => clientWith(stubResponse("NOT-INDEXED: exceeds the maximum size limit")),
			ALPHA_REPO,
			"big.txt",
			"larger than the indexer's size limit",
		],
		["other", () => clientWith(stubResponse("NOT-INDEXED: because")), ALPHA_REPO, "x", "because"],
	])(
		"NOT-INDEXED stub (%s) -> ZoektFileNotIndexedError",
		async (_name, makeClient, repo, path, detail) => {
			const error = await rejection(makeClient().print(repo, path));

			expect(error).toBeInstanceOf(ZoektFileNotIndexedError);
			expect(error.message).toBe(`File is not indexed by Zoekt (${detail}): ${repo}:${path}`);
		},
	);

	test("a large file that starts with NOT-INDEXED is content", async () => {
		const body = `NOT-INDEXED: ${"x".repeat(300)}`;
		const { bytes } = await clientWith(stubResponse(body)).print(ALPHA_REPO, "x");

		expect(new TextDecoder().decode(bytes)).toBe(body);
	});

	test.each([
		[
			"/search",
			"non-JSON response (content-type: text/html",
			(c: ReturnType<typeof clientWith>) => c.search({ query: "x" }),
		],
		[
			"/print",
			"ignored format=raw",
			(c: ReturnType<typeof clientWith>) => c.print(ALPHA_REPO, "x"),
		],
	])("200 text/html from %s is a protocol error", async (_endpoint, expected, call) => {
		const client = clientWith(stubResponse("<html>hi</html>", { contentType: "text/html" }));
		const error = await rejection(call(client));

		expect(error.message).toContain(expected);
	});
});
