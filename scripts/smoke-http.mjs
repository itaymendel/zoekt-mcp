#!/usr/bin/env node
// Zero-dependency Streamable HTTP smoke test for a built zoekt-mcp.
//
//   node scripts/smoke-http.mjs [--entry dist/index.js]
//
// Starts the server on a free port, POSTs initialize and tools/list to /mcp, checks /healthz,
// then sends SIGTERM and requires a clean exit (code 0) within 3 s.
// Exits 0 and prints "OK node vX http tools=a,b,c" on success, 1 with a message otherwise.
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	abort,
	assertTools,
	DUMMY_ZOEKT_URL,
	expectCleanExit,
	pkg,
	spawnServer,
} from "./lib/smoke-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXIT_TIMEOUT_MS = 3_000;
const PROTOCOL_VERSION = "2025-06-18";
const MCP_HEADERS = {
	"content-type": "application/json",
	accept: "application/json, text/event-stream",
};

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

const { values } = parseArgs({
	options: { entry: { type: "string", default: join(here, "..", "dist", "index.js") } },
	strict: true,
});

const port = await freePort();
const { child, exited } = spawnServer(
	process.execPath,
	[
		values.entry,
		...["--url", DUMMY_ZOEKT_URL, "--transport", "http", "--host", "127.0.0.1"],
		...["--port", String(port), "--log-level", "error"],
	],
	{ stdin: "ignore", stdout: "ignore" },
);

const base = `http://127.0.0.1:${port}`;

async function waitForHealthy() {
	for (let i = 0; i < 100; i++) {
		try {
			const res = await fetch(`${base}/healthz`);
			if (res.status === 200) return res;
		} catch {
			// not listening yet
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return abort("server never answered /healthz");
}

/** POST one JSON-RPC request to /mcp; the reply is JSON or a single SSE `data:` event. */
async function rpc(id, method, params) {
	const res = await fetch(`${base}/mcp`, {
		method: "POST",
		headers: MCP_HEADERS,
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
	});
	if (res.status !== 200) abort(`${method}: HTTP ${res.status}`);
	const text = await res.text();
	const payload = res.headers.get("content-type")?.includes("text/event-stream")
		? text
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.pop()
		: text;
	const message = JSON.parse(payload ?? "");
	if (message.error) abort(`${method} failed: ${JSON.stringify(message.error)}`);
	return message.result;
}

const health = await waitForHealthy();
const body = await health.json();
if (body.status !== "ok" || body.name !== pkg.name || body.version !== pkg.version) {
	abort(`unexpected /healthz body: ${JSON.stringify(body)}`);
}

const init = await rpc(1, "initialize", {
	protocolVersion: PROTOCOL_VERSION,
	capabilities: {},
	clientInfo: { name: "smoke-http", version: "0.0.0" },
});
if (init.serverInfo?.name !== pkg.name || init.serverInfo?.version !== pkg.version) {
	abort(`unexpected serverInfo: ${JSON.stringify(init.serverInfo)}`);
}

const list = await rpc(2, "tools/list", {});
const tools = list.tools ?? [];
assertTools(tools);

const removed = await fetch(`${base}/sse`);
if (removed.status !== 410) abort(`/sse returned ${removed.status}, expected 410`);

await expectCleanExit(exited, EXIT_TIMEOUT_MS, "SIGTERM", () => child.kill("SIGTERM"));

console.log(`OK node ${process.version} http tools=${tools.map((t) => t.name).join(",")}`);
process.exit(0);
