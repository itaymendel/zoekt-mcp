#!/usr/bin/env node
// Zero-dependency stdio smoke test for a built zoekt-mcp.
//
//   node scripts/smoke-stdio.mjs --entry dist/index.js
//   node scripts/smoke-stdio.mjs --bin ./zoekt-mcp
//
// Spawns the server over stdio, runs initialize -> initialized -> tools/list and checks the
// responses. Exits 0 and prints "OK node vX tools=a,b,c" on success, 1 with a message otherwise.
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
	abort,
	assertTools,
	DUMMY_ZOEKT_URL,
	expectCleanExit,
	fail,
	pkg,
	spawnServer,
} from "./lib/smoke-common.mjs";

const EXIT_TIMEOUT_MS = 5_000;
const PROTOCOL_VERSION = "2025-11-25";
const USAGE = "usage: smoke-stdio.mjs --entry <file> | --bin <exe>";

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

const { child, exited } = spawnServer(command, args);

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

const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

function request(id, method, params) {
	return new Promise((resolve) => {
		pending.set(id, resolve);
		send({ id, method, params });
	});
}

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
	assertTools(tools);

	child.stdin.end();
	await expectCleanExit(exited, EXIT_TIMEOUT_MS, "stdin close");

	console.log(`OK node ${process.version} tools=${tools.map((t) => t.name).join(",")}`);
}

await main();
