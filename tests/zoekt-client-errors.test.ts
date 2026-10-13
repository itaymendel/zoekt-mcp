import { describe, expect, test } from "bun:test";
import { MAX_ERROR_BODY } from "../src/zoekt/client.js";
import {
	ZoektAmbiguousFileError,
	ZoektFileNotFoundError,
	ZoektFileNotIndexedError,
	ZoektHttpError,
	ZoektProtocolError,
	ZoektQueryError,
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
	test("search-error-parse fixture -> ZoektQueryError with Zoekt's text", async () => {
		const client = clientWith(mockZoektFetch({ "/search": "search-error-parse" }));
		const error = await rejection(client.search({ query: "(" }));

		expect(error).toBeInstanceOf(ZoektQueryError);
		expect(error.message).toBe(
			"Zoekt rejected the request: query: missing close paren, got token <nil>",
		);
		expect(error.message).not.toMatch(/teapot|418/);
	});

	test("5xx includes status, statusText and body", async () => {
		const client = clientWith(stubResponse("boom", { status: 502, statusText: "Bad Gateway" }));
		const error = await rejection(client.search({ query: "x" }));

		expect(error).toBeInstanceOf(ZoektHttpError);
		expect(error.message).toBe("Zoekt /search failed: HTTP 502 Bad Gateway: boom");
	});

	test("empty error body omits the suffix", async () => {
		const client = clientWith(stubResponse("", { status: 503, statusText: "Service Unavailable" }));
		const error = await rejection(client.search({ query: "x" }));

		expect(error.message).toBe("Zoekt /search failed: HTTP 503 Service Unavailable");
	});

	test("blank runs in the body are collapsed", async () => {
		const client = clientWith(stubResponse("a\n\n\n  \nb\n", { status: 500, statusText: "ISE" }));
		const error = await rejection(client.search({ query: "x" }));

		expect(error.message).toBe("Zoekt /search failed: HTTP 500 ISE: a\nb");
	});

	test("MAX_ERROR_BODY is 500 and truncation happens only past it (499/500/501)", async () => {
		expect(MAX_ERROR_BODY).toBe(500);
		const failing = (n: number) =>
			rejection(
				clientWith(stubResponse("x".repeat(n), { status: 500, statusText: "ISE" })).search({
					query: "q",
				}),
			);

		expect((await failing(499)).message).toBe(
			`Zoekt /search failed: HTTP 500 ISE: ${"x".repeat(499)}`,
		);
		expect((await failing(500)).message).toBe(
			`Zoekt /search failed: HTTP 500 ISE: ${"x".repeat(500)}`,
		);
		const at501 = await failing(501);
		expect(at501.message).toBe(
			`Zoekt /search failed: HTTP 500 ISE: ${"x".repeat(500)}… (truncated, 501 chars total)`,
		);
		expect(at501.message.endsWith("… (truncated, 501 chars total)")).toBe(true);
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

	test("200 text/html -> ZoektProtocolError", async () => {
		const client = clientWith(stubResponse("<html>hi</html>", { contentType: "text/html" }));
		const error = await rejection(client.search({ query: "x" }));

		expect(error).toBeInstanceOf(ZoektProtocolError);
		expect(error.message).toContain("non-JSON response (content-type: text/html");
	});

	test("200 JSON of the wrong shape -> ZoektProtocolError", async () => {
		const client = clientWith(stubResponse("{}", { contentType: "application/json" }));
		const error = await rejection(client.search({ query: "x" }));

		expect(error).toBeInstanceOf(ZoektProtocolError);
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

	test("connection refused (undici-style cause)", async () => {
		const refuse = (async () => {
			throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
		}) as unknown as typeof fetch;
		const error = await rejection(
			clientWith(refuse, 5000, "http://zoekt.test:6070").search({ query: "x" }),
		);

		expect(error.message).toBe("Cannot reach Zoekt at http://zoekt.test:6070 (ECONNREFUSED)");
	});

	test("Bun-style ConnectionRefused is reported as ECONNREFUSED, credentials redacted", async () => {
		const refuse = (async () => {
			throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
		}) as unknown as typeof fetch;
		const error = await rejection(
			clientWith(refuse, 5000, "http://user:secret@zoekt.test:6070").search({ query: "x" }),
		);

		expect(error.message).toContain("(ECONNREFUSED)");
		expect(error.message).not.toContain("secret");
	});

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

	test("maxBytes truncates", async () => {
		const { bytes, truncated } = await printClient("print-ok").print(
			ALPHA_REPO,
			"docs/notes.txt",
			"main",
			{ maxBytes: 5 },
		);

		expect(new TextDecoder().decode(bytes)).toBe("first");
		expect(truncated).toBe(true);
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

	test("print-ambiguous -> ZoektAmbiguousFileError with versionCount >= 2", async () => {
		const error = await rejection(printClient("print-ambiguous").print(ALPHA_REPO, "Makefile"));

		expect(error).toBeInstanceOf(ZoektAmbiguousFileError);
		expect((error as ZoektAmbiguousFileError).versionCount).toBeGreaterThanOrEqual(2);
		expect(error.message).toContain("Pass a branch.");
	});

	test("print-not-indexed-binary -> reason binary", async () => {
		const error = await rejection(
			printClient("print-not-indexed-binary").print(DELTA_REPO, "bin.dat"),
		);

		expect(error).toBeInstanceOf(ZoektFileNotIndexedError);
		expect((error as ZoektFileNotIndexedError).reason).toBe("binary");
	});

	test("too-large stub -> reason too-large", async () => {
		const client = clientWith(stubResponse("NOT-INDEXED: exceeds the maximum size limit"));
		const error = await rejection(client.print(ALPHA_REPO, "big.txt"));

		expect(error).toBeInstanceOf(ZoektFileNotIndexedError);
		expect((error as ZoektFileNotIndexedError).reason).toBe("too-large");
	});

	test("an unknown NOT-INDEXED reason -> other", async () => {
		const client = clientWith(stubResponse("NOT-INDEXED: because"));
		const error = await rejection(client.print(ALPHA_REPO, "x"));

		expect((error as ZoektFileNotIndexedError).reason).toBe("other");
	});

	test("a large file that starts with NOT-INDEXED is content", async () => {
		const body = `NOT-INDEXED: ${"x".repeat(300)}`;
		const { bytes } = await clientWith(stubResponse(body)).print(ALPHA_REPO, "x");

		expect(new TextDecoder().decode(bytes)).toBe(body);
	});

	test("other 418 -> ZoektHttpError", async () => {
		const client = clientWith(
			stubResponse("error parsing regexp: foo", { status: 418, statusText: "I'm a teapot" }),
		);
		const error = await rejection(client.print(ALPHA_REPO, "x"));

		expect(error).toBeInstanceOf(ZoektHttpError);
		expect(error.message).toContain("error parsing regexp: foo");
	});

	test("200 text/html -> ZoektProtocolError mentioning format=raw", async () => {
		const client = clientWith(stubResponse("<html></html>", { contentType: "text/html" }));
		const error = await rejection(client.print(ALPHA_REPO, "x"));

		expect(error).toBeInstanceOf(ZoektProtocolError);
		expect(error.message).toContain("ignored format=raw");
	});

	test("404 is a plain HTTP error (the old dead 404 branch is gone)", async () => {
		const client = clientWith(stubResponse("nope", { status: 404, statusText: "Not Found" }));
		const error = await rejection(client.print(ALPHA_REPO, "x"));

		expect(error.message).toBe("Zoekt /print failed: HTTP 404 Not Found: nope");
	});
});
