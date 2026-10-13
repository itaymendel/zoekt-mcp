// Shared by smoke-stdio.mjs and smoke-http.mjs. Zero dependencies: node: builtins only.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8"));
export const expectedTools = JSON.parse(
	readFileSync(join(here, "..", "expected-tools.json"), "utf8"),
);

export const GLOBAL_TIMEOUT_MS = 20_000;
// Dummy upstream: never contacted during initialize/tools/list.
export const DUMMY_ZOEKT_URL = "http://127.0.0.1:9";

let child;
let stderr = "";
let globalTimer;
let exitExpected = false;

export function fail(message) {
	console.error(`FAIL ${message}`);
	process.exit(1);
}

/** Like fail, but also kills the server and appends what it wrote to stderr. */
export function abort(message) {
	child?.kill("SIGKILL");
	fail(`${message}${stderr ? `\nstderr: ${stderr.trim()}` : ""}`);
}

/** Spawns the server, captures stderr and arms the global timeout. */
export function spawnServer(command, args, { stdin = "pipe", stdout = "pipe" } = {}) {
	child = spawn(command, args, { stdio: [stdin, stdout, "pipe"] });
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.on("error", (error) => abort(`failed to spawn: ${error.message}`));
	globalTimer = setTimeout(
		() => abort(`timed out after ${GLOBAL_TIMEOUT_MS} ms`),
		GLOBAL_TIMEOUT_MS,
	);
	const exited = new Promise((resolve) =>
		child.on("exit", (code, signal) => {
			if (!exitExpected) abort(`server exited early (code ${code}, signal ${signal})`);
			resolve({ code, signal });
		}),
	);
	return { child, exited };
}

/**
 * Runs `trigger` (which should make the server exit), then waits for `exited`, failing if it takes
 * longer than timeoutMs or the exit code is not 0. Clears the global timeout on success.
 */
export async function expectCleanExit(exited, timeoutMs, label, trigger) {
	exitExpected = true;
	const timer = setTimeout(
		() => abort(`server did not exit within ${timeoutMs} ms of ${label}`),
		timeoutMs,
	);
	trigger();
	const { code, signal } = await exited;
	clearTimeout(timer);
	clearTimeout(globalTimer);
	if (code !== 0) fail(`server exited with code ${code} signal ${signal}`);
}

/** Every expected tool is listed and has an object inputSchema. */
export function assertTools(tools) {
	for (const name of expectedTools) {
		const tool = tools.find((t) => t.name === name);
		if (!tool) abort(`missing tool: ${name} (got ${tools.map((t) => t.name).join(",")})`);
		if (tool.inputSchema?.type !== "object") {
			abort(`tool ${name}: inputSchema.type is ${JSON.stringify(tool.inputSchema?.type)}`);
		}
	}
}
