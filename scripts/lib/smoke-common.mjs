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
	setTimeout(() => abort(`timed out after ${GLOBAL_TIMEOUT_MS} ms`), GLOBAL_TIMEOUT_MS).unref();
	const exited = new Promise((resolve) =>
		child.on("exit", (code, signal) => resolve({ code, signal })),
	);
	return { child, exited };
}

/** Waits for `exited`, failing if it takes longer than timeoutMs or the exit code is not 0. */
export async function expectCleanExit(exited, timeoutMs, trigger) {
	const timer = setTimeout(
		() => abort(`server did not exit within ${timeoutMs} ms of ${trigger}`),
		timeoutMs,
	);
	const { code, signal } = await exited;
	clearTimeout(timer);
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
