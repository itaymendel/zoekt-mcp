#!/usr/bin/env node
// Zero-dependency check of the published package. Packs the repo, installs the tarball into a
// scratch project and answers three questions about the installed bin:
//   1. does the tarball ship the right files and zero runtime dependencies?
//   2. does it start over stdio and list the three tools?
//   3. does it start over HTTP and answer /healthz?
//
//   bun run build && node scripts/check-package.mjs
//
// Exits 0 and prints "OK package ..." on success, 1 with a "FAIL ..." message otherwise.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const EXPECTED_FILES = ["CHANGELOG.md", "LICENSE", "README.md", "dist/index.js", "package.json"];
const EXPECTED_TOOLS = ["list_repos", "read_file", "search"];
const PROTOCOL_VERSION = "2025-11-25";
const TIMEOUT_MS = 15_000;
// Never contacted: neither initialize, tools/list nor /healthz reach upstream.
const DUMMY_ZOEKT_URL = "http://127.0.0.1:9";

const children = new Set();
const tmp = mkdtempSync(join(tmpdir(), "zoekt-mcp-package-"));
process.on("exit", () => {
	for (const child of children) child.kill("SIGKILL");
	rmSync(tmp, { recursive: true, force: true });
});

function fail(message) {
	console.error(`FAIL ${message}`);
	process.exit(1);
}

/** Runs a command and returns its stdout; a failure is reported with the command's stderr. */
function run(cmd, args, cwd) {
	try {
		return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (err) {
		return fail(`${cmd} ${args.join(" ")}\n${err.stderr || err.message}`.trim());
	}
}

/** Spawns the installed bin; the child is killed on exit, and a hang fails after TIMEOUT_MS. */
function spawnBin(bin, args, cwd) {
	const child = spawn(bin, [...args, "--url", DUMMY_ZOEKT_URL, "--log-level", "error"], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => process.stderr.write(chunk));
	child.on("error", (err) => fail(`failed to spawn ${bin}: ${err.message}`));
	child.on("exit", (code) => {
		if (!child.killed) fail(`server exited early (code ${code})`);
	});
	return child;
}

const deadline = (label) =>
	new Promise((_, reject) =>
		setTimeout(
			() => reject(new Error(`${label} timed out after ${TIMEOUT_MS} ms`)),
			TIMEOUT_MS,
		).unref(),
	);

/** Sends initialize then tools/list on stdin and returns the tool names from the id 2 response. */
async function listToolsOverStdio(bin, cwd) {
	const child = spawnBin(bin, ["--transport", "stdio"], cwd);
	const response = new Promise((resolve) => {
		let buffered = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffered += chunk;
			for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
				const line = buffered.slice(0, nl).trim();
				buffered = buffered.slice(nl + 1);
				if (!line) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					return fail(`stdout line is not JSON: ${line}`);
				}
				if (message.id === 2) resolve(message);
			}
		});
	});
	const send = (message) =>
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	send({
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "check-package", version: "0.0.0" },
		},
	});
	send({ id: 2, method: "tools/list", params: {} });
	const message = await Promise.race([response, deadline("stdio tools/list")]);
	child.kill();
	if (message.error) fail(`tools/list failed: ${JSON.stringify(message.error)}`);
	return (message.result?.tools ?? []).map((t) => t.name).sort();
}

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer().unref();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

/** Starts the bin over HTTP and polls /healthz until it answers; returns the status. */
async function healthzOverHttp(bin, cwd) {
	const port = await freePort();
	const child = spawnBin(
		bin,
		["--transport", "http", "--host", "127.0.0.1", "--port", String(port)],
		cwd,
	);
	const poll = (async () => {
		for (;;) {
			try {
				return (await fetch(`http://127.0.0.1:${port}/healthz`)).status;
			} catch {
				await new Promise((r) => setTimeout(r, 100));
			}
		}
	})();
	const status = await Promise.race([poll, deadline("HTTP /healthz")]);
	child.kill();
	return status;
}

const [packed] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", tmp], root));
const files = packed.files.map((f) => f.path).sort();
if (files.join(", ") !== EXPECTED_FILES.join(", ")) {
	fail(`unexpected tarball files: ${files.join(", ")}`);
}

const project = join(tmp, "install");
mkdirSync(project);
run("npm", ["init", "-y"], project);
run(
	"npm",
	["install", join(tmp, packed.filename), "--ignore-scripts", "--no-audit", "--no-fund"],
	project,
);

const installed = run("npm", ["ls", "--all", "--parseable"], project).trim().split("\n");
if (installed.length !== 2) {
	fail(
		`expected 2 installed packages (root + zoekt-mcp), got ${installed.length}:\n${installed.join("\n")}`,
	);
}

const bin = join(project, "node_modules", ".bin", "zoekt-mcp");
try {
	const tools = await listToolsOverStdio(bin, project);
	if (tools.join(",") !== EXPECTED_TOOLS.join(",")) {
		fail(`stdio tools/list returned ${tools.join(",")}, expected ${EXPECTED_TOOLS.join(",")}`);
	}
	const status = await healthzOverHttp(bin, project);
	if (status !== 200) fail(`/healthz returned ${status}`);
} catch (err) {
	fail(err.message);
}
console.log(
	`OK package zoekt-mcp@${pkg.version} files=${files.length} installed=${installed.length} tools=${EXPECTED_TOOLS.join(",")} node=${process.version}`,
);
