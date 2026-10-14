#!/usr/bin/env node
// Packs the repo, installs the tarball into a scratch project and checks the installed bin:
// exact file list, zero runtime dependencies, stdio tools/list, HTTP /healthz.
//   bun run build && node scripts/check-package.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["CHANGELOG.md", "LICENSE", "README.md", "dist/index.js", "package.json"];
const TOOLS = ["list_repos", "read_file", "search"];
const tmp = mkdtempSync(join(tmpdir(), "zoekt-mcp-package-"));
const children = [];
process.on("exit", () => {
	for (const c of children) c.kill("SIGKILL");
	rmSync(tmp, { recursive: true, force: true });
});

const fail = (msg) => {
	console.error(`FAIL ${msg}`);
	process.exit(1);
};
const run = (args, cwd) => {
	try {
		return execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (err) {
		return fail(`npm ${args.join(" ")}\n${err.stderr || err.message}`);
	}
};
/** Spawns the installed bin; a hang or early exit fails the check. Zoekt is never contacted. */
const spawnBin = (bin, args) => {
	const child = spawn(bin, [...args, "--url", "http://127.0.0.1:9", "--log-level", "error"]);
	children.push(child);
	child.stdout.setEncoding("utf8");
	child.on("error", (err) => fail(`failed to spawn ${bin}: ${err.message}`));
	child.stderr.pipe(process.stderr);
	child.on("exit", (code) => !child.killed && fail(`server exited early (code ${code})`));
	setTimeout(() => fail("timed out after 15s"), 15_000).unref();
	return child;
};

const [packed] = JSON.parse(run(["pack", "--json", "--pack-destination", tmp], root));
const files = packed.files.map((f) => f.path).sort();
if (files.join() !== FILES.join()) fail(`unexpected tarball files: ${files.join(", ")}`);

const project = join(tmp, "install");
mkdirSync(project);
run(["init", "-y"], project);
run(
	["install", join(tmp, packed.filename), "--ignore-scripts", "--no-audit", "--no-fund"],
	project,
);
const installed = join(project, "node_modules", "zoekt-mcp");
const { dependencies = {}, version } = JSON.parse(
	readFileSync(join(installed, "package.json"), "utf8"),
);
if (Object.keys(dependencies).length > 0)
	fail(`runtime dependencies: ${Object.keys(dependencies)}`);

const bin = join(project, "node_modules", ".bin", "zoekt-mcp");
const stdio = spawnBin(bin, ["--transport", "stdio"]);
const send = (message) => stdio.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
send({
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "check-package", version: "0.0.0" },
	},
});
send({ id: 2, method: "tools/list", params: {} });
const tools = await new Promise((resolve) => {
	let buffered = "";
	stdio.stdout.on("data", (chunk) => {
		buffered += chunk;
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith("{")) continue;
			const message = JSON.parse(line);
			if (message.id === 2) resolve((message.result?.tools ?? []).map((t) => t.name).sort());
		}
	});
});
stdio.kill();
if (tools.join() !== TOOLS.join()) fail(`stdio tools/list returned ${tools}, expected ${TOOLS}`);

const port = await new Promise((resolve) => {
	const srv = createServer().listen(0, "127.0.0.1", () => {
		const { port } = srv.address();
		srv.close(() => resolve(port));
	});
});
const http = spawnBin(bin, ["--transport", "http", "--host", "127.0.0.1", "--port", String(port)]);
let status;
while (status === undefined) {
	status = await fetch(`http://127.0.0.1:${port}/healthz`).then(
		(r) => r.status,
		() => new Promise((r) => setTimeout(r, 100)),
	);
}
http.kill();
if (status !== 200) fail(`/healthz returned ${status}`);
console.log(
	`OK package zoekt-mcp@${version} files=${files.length} tools=${TOOLS} node=${process.version}`,
);
