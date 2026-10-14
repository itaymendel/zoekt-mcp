/**
 * Captures real Zoekt responses into tests/fixtures/zoekt (needs Docker; the tests do not).
 *
 *   bun run fixtures:capture
 *
 * Builds the synthetic repositories from tests/fixtures/zoekt/repos, indexes them with the
 * pinned image, replays CASES against zoekt-webserver and writes one envelope per case plus
 * MANIFEST.json. Output is deterministic: running it twice leaves the working tree unchanged.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	ALPHA_REPO,
	CASES_DIR,
	DELTA_REPO,
	FIXTURE_REPOS,
	type FixtureRepo,
	GIT_FIXED_ENV,
	MANIFEST_PATH,
	REPO_SOURCES_DIR,
	sha256,
} from "../tests/helpers/fixture-repo.js";
import type { ZoektManifest } from "../tests/helpers/zoekt-fixtures.js";
import { indexRepos, startWebserver, stop, ZOEKT_IMAGE } from "./lib/zoekt-docker.js";

interface CaseDef {
	name: string;
	path: string;
	query: Record<string, string>;
}

const search = (name: string, q: string, extra: Record<string, string> = {}): CaseDef => ({
	name,
	path: "/search",
	query: { q, ...extra, format: "json" },
});

const print = (name: string, f: string, extra: Record<string, string> = {}): CaseDef => ({
	name,
	path: "/print",
	query: { r: ALPHA_REPO, format: "raw", f, ...extra },
});

const CASES: CaseDef[] = [
	search("search-multi-fragment", "handleRequest", { ctx: "0" }),
	search("search-context", "needle", { ctx: "1" }),
	search("search-file-only", "f:notes"),
	search("search-many-files", "common token", { num: "3" }),
	search("search-sym", "sym:lookup", { ctx: "0" }),
	search("list-all", 'r:"."'),
	search("list-filter", 'r:"(?i)ALPHA"'),
	search("search-error-parse", "("),
	print("print-ok", "docs/notes.txt", { b: "main" }),
	print("print-not-found", "nope.txt"),
	print("print-ambiguous", "Makefile"),
	{
		name: "print-not-indexed-binary",
		path: "/print",
		query: { r: DELTA_REPO, f: "bin.dat", format: "raw" },
	},
	{ name: "readyz-ok", path: "/readyz", query: {} },
];

/** Timing and index-time values vary per run; everything else is kept verbatim. */
const SCRUB_STATS = new Set(["Duration", "Wait", "MatchTreeConstruction", "MatchTreeSearch"]);

function scrub(value: unknown, parentKey = ""): unknown {
	if (Array.isArray(value)) return value.map((item) => scrub(item, parentKey));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			if (key === "IndexTime") out[key] = "1970-01-01T00:00:00Z";
			else if (parentKey === "Stats" && SCRUB_STATS.has(key)) out[key] = 0;
			else out[key] = scrub(child, key);
		}
		return out;
	}
	return value;
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
		cwd,
		env: { ...process.env, ...GIT_FIXED_ENV },
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function buildRepo(repo: FixtureRepo, reposDir: string): void {
	const dest = join(reposDir, repo.dir);
	cpSync(join(REPO_SOURCES_DIR, repo.dir), dest, { recursive: true });
	git(dest, ["init", "-q", "-b", "main"]);
	git(dest, ["config", "zoekt.name", repo.name]);
	git(dest, ["add", "-A"]);
	git(dest, ["commit", "-q", "-m", "initial"]);
	for (const [branch, files] of Object.entries(repo.overlays)) {
		git(dest, ["checkout", "-q", "-b", branch, "main"]);
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(dest, path)), { recursive: true });
			writeFileSync(join(dest, path), content);
		}
		git(dest, ["add", "-A"]);
		git(dest, ["commit", "-q", "-m", `change on ${branch}`]);
		git(dest, ["checkout", "-q", "main"]);
	}
}

async function capture(baseUrl: string, def: CaseDef) {
	const url = new URL(def.path, baseUrl);
	url.search = new URLSearchParams(def.query).toString();
	const res = await fetch(url);
	const contentType = res.headers.get("content-type") ?? "";
	const text = await res.text();
	const response: Record<string, unknown> = { status: res.status, contentType };
	if (contentType.includes("json")) response.body = scrub(JSON.parse(text));
	else response.bodyText = text;
	const request: Record<string, unknown> = {
		method: "GET",
		path: def.path,
		query: def.query,
	};
	return { request, response };
}

async function main() {
	const work = mkdtempSync(join(tmpdir(), "zoekt-fixtures-"));
	const reposDir = join(work, "repos");
	const indexDir = join(work, "index");
	mkdirSync(reposDir);
	mkdirSync(indexDir);

	let containerId: string | undefined;
	try {
		for (const repo of FIXTURE_REPOS) buildRepo(repo, reposDir);
		indexRepos(reposDir, indexDir, FIXTURE_REPOS);

		const server = await startWebserver(indexDir);
		containerId = server.containerId;

		rmSync(CASES_DIR, { recursive: true, force: true });
		mkdirSync(CASES_DIR, { recursive: true });

		const hashes: Record<string, string> = {};
		for (const def of CASES) {
			const file = `${JSON.stringify(await capture(server.baseUrl, def), null, "\t")}\n`;
			writeFileSync(join(CASES_DIR, `${def.name}.json`), file);
			hashes[`${def.name}.json`] = sha256(file);
			console.log(`captured ${def.name}`);
		}

		const manifest: ZoektManifest = { image: ZOEKT_IMAGE, cases: hashes };
		writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, "\t")}\n`);
		console.log(`wrote ${CASES.length} cases and MANIFEST.json`);
	} finally {
		if (containerId) stop(containerId);
		rmSync(work, { recursive: true, force: true });
	}
}

await main();
