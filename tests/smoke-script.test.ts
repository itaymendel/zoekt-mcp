import { describe, expect, test } from "bun:test";

async function runSmoke(entry: string) {
	const proc = Bun.spawn(["node", "scripts/smoke-stdio.mjs", "--entry", entry], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("scripts/smoke-stdio.mjs", () => {
	test("fails and names the offending line when the server writes non-JSON to stdout", async () => {
		const { stderr, exitCode } = await runSmoke("tests/fixtures/smoke/bad-stdout.mjs");

		expect(exitCode).toBe(1);
		expect(stderr).toContain("not JSON");
		expect(stderr).toContain("hello, this is not json-rpc");
	});
});
