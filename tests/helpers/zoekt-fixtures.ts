import { readFileSync } from "node:fs";
import { CASES_URL, MANIFEST_URL } from "./fixture-repo.js";

/** One captured Zoekt exchange, as written by scripts/capture-zoekt-fixtures.ts. */
export interface ZoektCase {
	request: { method: string; path: string; query: Record<string, string> };
	response: {
		status: number;
		contentType: string;
		body?: unknown;
		bodyText?: string;
	};
}

/** Shape of tests/fixtures/zoekt/MANIFEST.json. */
export interface ZoektManifest {
	image: string;
	/** case file name -> sha256 of the file contents */
	cases: Record<string, string>;
}

export function loadManifest(): ZoektManifest {
	return JSON.parse(readFileSync(MANIFEST_URL, "utf8")) as ZoektManifest;
}

export function loadCase(name: string): ZoektCase {
	return JSON.parse(readFileSync(new URL(`${name}.json`, CASES_URL), "utf8")) as ZoektCase;
}

export function caseToResponse(name: string): Response {
	const { response } = loadCase(name);
	const text = response.body !== undefined ? JSON.stringify(response.body) : response.bodyText;
	return new Response(text ?? "", {
		status: response.status,
		headers: response.contentType ? { "Content-Type": response.contentType } : {},
	});
}

/** pathname -> case name, or a function building the Response from the request URL. */
export type ZoektRoutes = Record<string, string | ((url: URL) => Response | Promise<Response>)>;

export type MockZoektFetch = typeof fetch & { requests: URL[] };

/** A fetch replacement serving fixtures by pathname. Records every request; unknown paths throw. */
export function mockZoektFetch(routes: ZoektRoutes): MockZoektFetch {
	const requests: URL[] = [];
	const mock = async (input: RequestInfo | URL): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		requests.push(url);
		const route = routes[url.pathname];
		if (route === undefined) {
			throw new Error(`mockZoektFetch: no route for ${url.pathname}`);
		}
		return typeof route === "string" ? caseToResponse(route) : route(url);
	};
	return Object.assign(mock, { requests }) as MockZoektFetch;
}
