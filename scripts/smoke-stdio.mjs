#!/usr/bin/env node
// Zero-dependency stdio smoke test for a built zoekt-mcp.
//
//   node scripts/smoke-stdio.mjs --entry dist/index.js
//   node scripts/smoke-stdio.mjs --bin ./zoekt-mcp
//
// Spawns the server over stdio, runs initialize -> initialized -> tools/list and checks the
// responses. Exits 0 and prints "OK node vX tools=a,b,c" on success, 1 with a message otherwise.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const expectedTools = JSON.parse(readFileSync(join(here, "expected-tools.json"), "utf8"));

const GLOBAL_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 5_000;
const PROTOCOL_VERSION = "2025-11-25";
// Dummy upstream: never contacted during initialize/tools/list.
const DUMMY_ZOEKT_URL = "http://127.0.0.1:9";
const USAGE = "usage: smoke-stdio.mjs --entry <file> | --bin <exe>";

let child;
let stderr = "";
let globalTimer;

function fail(message) {
	console.error(`FAIL ${message}`);
	process.exit(1);
}

function abort(message) {
	clearTimeout(globalTimer);
	child?.kill("SIGKILL");
	fail(`${message}${stderr ? `\nstderr: ${stderr.trim()}` : ""}`);
}

function parseCli(argv) {
	let values;
	try {
		({ values } = parseArgs({
			args: argv,
			options: { entry: { type: "string" }, bin: { type: "string" } },
			strict: true,
		}));
	} catch (error) {
		return fail(`${error.message}\n${USAGE}`);
	}
	if (!values.entry === !values.bin) {
		fail(`${USAGE} (exactly one)`);
	}
	return values;
}

const opts = parseCli(process.argv.slice(2));
const serverArgs = ["--url", DUMMY_ZOEKT_URL, "--transport", "stdio", "--log-level", "error"];
const [command, args] = opts.entry
	? [process.execPath, [opts.entry, ...serverArgs]]
	: [opts.bin, serverArgs];

child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (chunk) => {
	stderr += chunk;
});

globalTimer = setTimeout(() => abort(`timed out after ${GLOBAL_TIMEOUT_MS} ms`), GLOBAL_TIMEOUT_MS);

const pending = new Map();

createInterface({ input: child.stdout }).on("line", (line) => {
	if (line.length > 0) handleLine(line);
});

function handleLine(line) {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return abort(`stdout line is not JSON: ${JSON.stringify(line)}`);
	}
	if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
		return abort(`stdout line is not a JSON-RPC 2.0 message: ${JSON.stringify(line)}`);
	}
	if (message.id !== undefined && ("result" in message || "error" in message)) {
		const resolve = pending.get(message.id);
		if (resolve) {
			pending.delete(message.id);
			resolve(message);
		}
	}
}

child.on("error", (error) => abort(`failed to spawn: ${error.message}`));

const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

function request(id, method, params) {
	return new Promise((resolve) => {
		pending.set(id, resolve);
		send({ id, method, params });
	});
}

const exited = new Promise((resolve) =>
	child.on("exit", (code, signal) => resolve({ code, signal })),
);

async function main() {
	const init = await request(1, "initialize", {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: { name: "smoke-stdio", version: "0.0.0" },
	});
	if (init.error) abort(`initialize failed: ${JSON.stringify(init.error)}`);
	const info = init.result?.serverInfo;
	if (info?.name !== pkg.name) {
		abort(`serverInfo.name ${JSON.stringify(info?.name)} !== ${JSON.stringify(pkg.name)}`);
	}
	if (info?.version !== pkg.version) {
		abort(`serverInfo.version ${JSON.stringify(info?.version)} !== ${JSON.stringify(pkg.version)}`);
	}

	send({ method: "notifications/initialized" });

	const list = await request(2, "tools/list", {});
	if (list.error) abort(`tools/list failed: ${JSON.stringify(list.error)}`);
	const tools = list.result?.tools ?? [];
	for (const name of expectedTools) {
		const tool = tools.find((t) => t.name === name);
		if (!tool) abort(`missing tool: ${name} (got ${tools.map((t) => t.name).join(",")})`);
		if (tool.inputSchema?.type !== "object") {
			abort(`tool ${name}: inputSchema.type is ${JSON.stringify(tool.inputSchema?.type)}`);
		}
	}

	child.stdin.end();
	const exitTimer = setTimeout(
		() => abort(`server did not exit within ${EXIT_TIMEOUT_MS} ms of stdin close`),
		EXIT_TIMEOUT_MS,
	);
	const { code, signal } = await exited;
	clearTimeout(exitTimer);
	clearTimeout(globalTimer);
	if (code !== 0) fail(`server exited with code ${code} signal ${signal}`);

	console.log(`OK node ${process.version} tools=${tools.map((t) => t.name).join(",")}`);
}

await main();
