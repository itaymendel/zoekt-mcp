import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ENV_KEYS } from "../src/config.js";
import { run } from "./helpers/cli.js";
import { expectGolden } from "./helpers/golden.js";

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
});

describe("--help", () => {
	test("matches the snapshot", async () => {
		const { stdout, exitCode } = await help();

		expect(exitCode).toBe(0);
		expectGolden("help.txt", stdout);
	});
});
