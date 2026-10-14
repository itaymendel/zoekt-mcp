import { describe, expect, test } from "bun:test";
import {
	ZoektAmbiguousFileError,
	ZoektFileNotFoundError,
	ZoektFileNotIndexedError,
} from "../src/zoekt/errors.js";
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

	test.each([
		[
			"5xx includes status, statusText and body",
			"boom",
			502,
			"Bad Gateway",
			"text/plain",
			": boom",
		],
		["an empty body omits the suffix", "", 503, "Service Unavailable", "text/plain", ""],
		[
			"a body of exactly the cap is quoted whole",
			"x".repeat(500),
			500,
			"ISE",
			"text/plain",
			`: ${"x".repeat(500)}`,
		],
		[
			"a longer body is truncated with the total length",
			"x".repeat(600),
			500,
			"ISE",
			"text/plain",
			`: ${"x".repeat(500)}… (truncated, 600 chars total)`,
		],
		[
			"an HTML page is summarized, not dumped",
			"<html><body>nginx</body></html>",
			502,
			"Bad Gateway",
			"text/html",
			": <HTML page; is ZOEKT_URL pointing at zoekt-webserver?>",
		],
	])("%s", async (_name, body, status, statusText, contentType, suffix) => {
		const client = clientWith(stubResponse(body, { status, statusText, contentType }));
		const error = await rejection(client.search({ query: "x" }));

		expect(error.message).toBe(`Zoekt /search failed: HTTP ${status} ${statusText}${suffix}`);
	});

	test("200 with a non-JSON body", async () => {
		const client = clientWith(stubResponse("oops"));
		const error = await rejection(client.search({ query: "x" }));

		expect(error.message).toContain("returned a non-JSON response");
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
				/^Cannot reach Zoekt at http:\/\/zoekt\.test:6070 \(ECONNREFUSED\)$/,
			);
			expect(error.message).not.toContain("secret");
		},
	);
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

	test.each([
		["without a branch", undefined, ""],
		["naming the branch", "dev", " (branch dev)"],
	])("print-not-found %s -> ZoektFileNotFoundError", async (_name, branch, suffix) => {
		const error = await rejection(
			printClient("print-not-found").print(ALPHA_REPO, "nope.txt", branch),
		);

		expect(error).toBeInstanceOf(ZoektFileNotFoundError);
		expect(error.message).toBe(`File not found in index: example.test/alpha:nope.txt${suffix}`);
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
			"contains binary content",
		],
		[
			"too large",
			() => clientWith(stubResponse("NOT-INDEXED: exceeds the maximum size limit")),
			ALPHA_REPO,
			"big.txt",
			"exceeds the maximum size limit",
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
			"returned an HTML page",
			(c: ReturnType<typeof clientWith>) => c.search({ query: "x" }),
		],
		[
			"/print",
			"returned an HTML page",
			(c: ReturnType<typeof clientWith>) => c.print(ALPHA_REPO, "x"),
		],
	])("200 text/html from %s is a protocol error", async (_endpoint, expected, call) => {
		const client = clientWith(stubResponse("<html>hi</html>", { contentType: "text/html" }));
		const error = await rejection(call(client));

		expect(error.message).toContain(expected);
	});
});
