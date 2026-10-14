import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { CASES_URL, sha256 } from "./helpers/fixture-repo.js";
import { loadManifest } from "./helpers/zoekt-fixtures.js";

test("MANIFEST sha256 matches every case file", () => {
	const manifest = loadManifest();
	const files = readdirSync(CASES_URL).sort();
	expect(Object.keys(manifest.cases).sort()).toEqual(files);
	for (const file of files) {
		const digest = sha256(readFileSync(new URL(file, CASES_URL)));
		expect(digest).toBe(manifest.cases[file]);
	}
});
