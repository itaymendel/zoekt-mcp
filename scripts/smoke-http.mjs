#!/usr/bin/env node
// Zero-dependency Streamable HTTP smoke test for a built zoekt-mcp.
//
//   node scripts/smoke-http.mjs [--entry dist/index.js]
//
// Starts the server on a free port, POSTs initialize and tools/list to /mcp, checks /healthz,
// then sends SIGTERM and requires a clean exit (code 0) within 3 s.
// Exits 0 and prints "OK node vX http tools=a,b,c" on success, 1 with a message otherwise.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const expectedTools = JSON.parse(readFileSync(join(here, "expected-tools.json"), "utf8"));

const GLOBAL_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 3_000;
const PROTOCOL_VERSION = "2025-06-18";
const DUMMY_ZOEKT_URL = "http://127.0.0.1:9";
const MCP_HEADERS = {
	"content-type": "application/json",
	accept: "application/json, text/event-stream",
};

let child;
let stderr = "";

function fail(message) {
	console.error(`FAIL ${message}${stderr ? `\nstderr: ${stderr.trim()}` : ""}`);
	child?.kill("SIGKILL");
	process.exit(1);
}

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

setTimeout(() => fail(`timed out after ${GLOBAL_TIMEOUT_MS} ms`), GLOBAL_TIMEOUT_MS).unref();

const port = await freePort();
child = spawn(
	process.execPath,
	[
		values.entry,
		...["--url", DUMMY_ZOEKT_URL, "--transport", "http", "--host", "127.0.0.1"],
		...["--port", String(port), "--log-level", "error"],
	],
	{ stdio: ["ignore", "pipe", "pipe"] },
);
child.stderr.on("data", (chunk) => {
	stderr += chunk;
});
child.stdout.resume();
const exited = new Promise((resolve) =>
	child.on("exit", (code, signal) => resolve({ code, signal })),
);
child.on("error", (error) => fail(`failed to spawn: ${error.message}`));

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
	return fail("server never answered /healthz");
}

/** POST one JSON-RPC request to /mcp; the reply is JSON or a single SSE `data:` event. */
async function rpc(id, method, params) {
	const res = await fetch(`${base}/mcp`, {
		method: "POST",
		headers: MCP_HEADERS,
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
	});
	if (res.status !== 200) fail(`${method}: HTTP ${res.status}`);
	const text = await res.text();
	const payload = res.headers.get("content-type")?.includes("text/event-stream")
		? text
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.pop()
		: text;
	const message = JSON.parse(payload ?? "");
	if (message.error) fail(`${method} failed: ${JSON.stringify(message.error)}`);
	return message.result;
}

const health = await waitForHealthy();
const body = await health.json();
if (body.status !== "ok" || body.name !== pkg.name || body.version !== pkg.version) {
	fail(`unexpected /healthz body: ${JSON.stringify(body)}`);
}

const init = await rpc(1, "initialize", {
	protocolVersion: PROTOCOL_VERSION,
	capabilities: {},
	clientInfo: { name: "smoke-http", version: "0.0.0" },
});
if (init.serverInfo?.name !== pkg.name || init.serverInfo?.version !== pkg.version) {
	fail(`unexpected serverInfo: ${JSON.stringify(init.serverInfo)}`);
}

const list = await rpc(2, "tools/list", {});
const tools = list.tools ?? [];
for (const name of expectedTools) {
	if (!tools.some((t) => t.name === name)) fail(`missing tool: ${name}`);
}

const removed = await fetch(`${base}/sse`);
if (removed.status !== 410) fail(`/sse returned ${removed.status}, expected 410`);

child.kill("SIGTERM");
const timer = setTimeout(
	() => fail(`server did not exit within ${EXIT_TIMEOUT_MS} ms of SIGTERM`),
	EXIT_TIMEOUT_MS,
);
const { code, signal } = await exited;
clearTimeout(timer);
if (code !== 0) fail(`server exited with code ${code} signal ${signal}`);

console.log(`OK node ${process.version} http tools=${tools.map((t) => t.name).join(",")}`);
process.exit(0);
