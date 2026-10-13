import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { trackSockets } from "../../src/http.js";
import { loadCase } from "./zoekt-fixtures.js";

export interface FakeZoekt {
	/** e.g. http://127.0.0.1:54321 */
	url: string;
	/** Pathnames requested so far. */
	requests: string[];
	/** Resolves with the next request path not yet returned by this method (in arrival order). */
	nextRequest(): Promise<string>;
	close(): Promise<void>;
}

/**
 * A real node:http Zoekt stand-in on 127.0.0.1:0. `routes` maps pathname -> fixture case name and
 * replays the captured response; with `hang: true` requests are accepted and never answered.
 */
export async function startFakeZoekt(
	options: { routes?: Record<string, string>; hang?: boolean } = {},
): Promise<FakeZoekt> {
	const requests: string[] = [];
	const waiters: Array<() => void> = [];
	let consumed = 0;
	const server = createServer((req, res) => {
		const { pathname } = new URL(req.url ?? "/", "http://placeholder");
		requests.push(pathname);
		for (const wake of waiters.splice(0)) wake();
		if (options.hang) return;
		const route = options.routes?.[pathname];
		if (route === undefined) return void res.writeHead(404).end();
		const { response } = loadCase(route);
		const body = response.body !== undefined ? JSON.stringify(response.body) : response.bodyText;
		res.writeHead(response.status, { "Content-Type": response.contentType });
		res.end(body ?? "");
	});
	const connections = trackSockets(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		async nextRequest() {
			while (consumed >= requests.length) {
				await new Promise<void>((resolve) => waiters.push(resolve));
			}
			return requests[consumed++] as string;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				connections.destroyAll();
			}),
	};
}
