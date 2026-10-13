import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ENV_KEYS } from "../src/config.js";
import { searchDescription } from "../src/tools/search.js";
import { run } from "./helpers/cli.js";
import { expectGolden } from "./helpers/golden.js";
import { SEARCH_SYNTAX_NEEDLES } from "./helpers/needles.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/** The text of a `## ` section, up to the next `## ` heading. */
function section(heading: string): string {
	const start = readme.indexOf(`\n## ${heading}\n`);
	if (start === -1) throw new Error(`README has no "## ${heading}" section`);
	const rest = readme.slice(start + 1);
	const next = rest.indexOf("\n## ", 1);
	return next === -1 ? rest : rest.slice(0, next);
}

const help = () => run(["--help"]);

describe("README configuration table", () => {
	test("lists exactly the environment variables src/config.ts reads", () => {
		const rows = section("Configuration")
			.split("\n")
			.filter((line) => line.startsWith("|"));
		const documented = rows
			.map((row) => row.split("|")[2]?.match(/`([A-Z][A-Z0-9_]+)`/)?.[1])
			.filter((name): name is string => name !== undefined);

		expect(documented.sort()).toEqual([...ENV_KEYS].sort());
	});

	test("every zoekt-mcp --flag in the README appears in --help", async () => {
		const flagsIn = (text: string) => text.match(/(?<![\w-])--[a-z][a-z-]*/g) ?? [];
		const flags = new Set<string>();
		// Flags after a `zoekt-mcp` command (the Releasing section talks about npm and gh), and the
		// first column of the configuration table.
		for (const line of readme.split("\n## Releasing")[0]?.split("\n") ?? []) {
			const at = line.search(/zoekt-mcp(@next)?( |$)/);
			if (at !== -1 && !line.startsWith("|")) for (const f of flagsIn(line.slice(at))) flags.add(f);
		}
		for (const row of section("Configuration").split("\n")) {
			if (row.startsWith("|")) for (const f of flagsIn(row.split("|")[1] ?? "")) flags.add(f);
		}
		const { stdout } = await help();

		expect(flags.size).toBeGreaterThanOrEqual(6);
		for (const flag of flags) expect(stdout, flag).toContain(flag);
	});
});

describe("--help", () => {
	test("is at most 25 lines and matches the snapshot", async () => {
		const { stdout, exitCode } = await help();

		expect(exitCode).toBe(0);
		expect(stdout.trimEnd().split("\n").length).toBeLessThanOrEqual(25);
		expectGolden("help.txt", stdout);
	});
});

describe("README cheat sheet", () => {
	test("teaches what the search description teaches", () => {
		const cheatSheet = section("Tools");
		for (const needle of SEARCH_SYNTAX_NEEDLES) {
			expect(searchDescription, needle).toContain(needle);
			expect(cheatSheet, needle).toContain(needle);
		}
	});

	test("shows both a stdio and an HTTP claude mcp add", () => {
		expect(readme).toMatch(/claude mcp add zoekt -e ZOEKT_URL=\S+ -- npx -y zoekt-mcp@next/);
		expect(readme).toMatch(/claude mcp add --transport http zoekt http:\/\/127\.0\.0\.1:3000\/mcp/);
	});

	test("states the minimum Zoekt version", () => {
		expect(readme).toContain("2025-01-30");
	});
});
