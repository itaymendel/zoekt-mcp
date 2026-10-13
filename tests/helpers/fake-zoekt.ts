import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { loadCase } from "./zoekt-fixtures.js";

export interface FakeZoekt {
	/** e.g. http://127.0.0.1:54321 */
	url: string;
	/** Pathnames requested so far. */
	requests: string[];
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
	const server = createServer((req, res) => {
		const { pathname } = new URL(req.url ?? "/", "http://placeholder");
		requests.push(pathname);
		if (options.hang) return;
		const route = options.routes?.[pathname];
		if (route === undefined) return void res.writeHead(404).end();
		const { response } = loadCase(route);
		const body = response.body !== undefined ? JSON.stringify(response.body) : response.bodyText;
		res.writeHead(response.status, { "Content-Type": response.contentType });
		res.end(body ?? "");
	});
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
				for (const socket of sockets) socket.destroy();
			}),
	};
}
