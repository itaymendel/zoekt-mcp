import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Asserts `actual` equals tests/golden/<name>; `UPDATE_GOLDEN=1` rewrites the file instead. */
export function expectGolden(name: string, actual: string): void {
	const url = new URL(`../golden/${name}`, import.meta.url);
	if (process.env.UPDATE_GOLDEN === "1") {
		writeFileSync(url, actual);
		return;
	}
	if (!existsSync(url)) {
		throw new Error(
			`Golden file tests/golden/${name} is missing; run with UPDATE_GOLDEN=1 to create it`,
		);
	}
	expect(actual).toBe(readFileSync(url, "utf8"));
}
