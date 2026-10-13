#!/usr/bin/env node
// Zero-dependency check of the published package: packs the repo, installs the tarball into a
// scratch project and verifies the file list, the dependency footprint, --version and a stdio smoke.
//
//   bun run build && node scripts/check-package.mjs
//
// Exits 0 and prints "OK package ..." on success, 1 with a "FAIL ..." message otherwise.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, pkg } from "./lib/smoke-common.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_FILES = ["CHANGELOG.md", "LICENSE", "README.md", "dist/index.js", "package.json"];

/** Runs a command and returns its stdout; a failure is reported with the command's stderr. */
function run(cmd, args, cwd) {
	try {
		return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (err) {
		return fail(`${cmd} ${args.join(" ")}\n${err.stderr || err.message}`.trim());
	}
}

const tmp = mkdtempSync(join(tmpdir(), "zoekt-mcp-package-"));
// fail() exits the process, so cleanup runs on every path via the exit hook.
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

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
const version = run(bin, ["--version"], project).trim();
if (version !== `zoekt-mcp ${pkg.version}`) {
	fail(`--version printed "${version}", expected "zoekt-mcp ${pkg.version}"`);
}

run("node", [join(root, "scripts", "smoke-stdio.mjs"), "--bin", bin], project);
console.log(
	`OK package zoekt-mcp@${pkg.version} files=${files.length} installed=${installed.length}`,
);
