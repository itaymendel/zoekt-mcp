import { describe, expect, test } from "bun:test";
import { run, type Spawned, spawn } from "./helpers/cli.js";

const TOKEN = "0123456789abcdef-secret";

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
	const { port } = probe;
	await probe.stop(true);
	return port as number;
}

/** Drains stderr in the background; `until` polls the accumulated text. */
function captureStderr(proc: Spawned) {
	const capture = { text: "" };
	const decoder = new TextDecoder();
	const done = (async () => {
		for await (const chunk of proc.stderr) capture.text += decoder.decode(chunk, { stream: true });
	})();
	return {
		get text() {
			return capture.text;
		},
		done,
		async until(predicate: (text: string) => boolean, ms = 8000) {
			const deadline = Date.now() + ms;
			while (!predicate(capture.text) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			return capture.text;
		},
	};
}

describe("exit codes", () => {
	test("stdio is the default: exits 0 on EOF", async () => {
		const started = performance.now();
		const { exitCode } = await run(["--url", "http://127.0.0.1:9"]);

		expect(exitCode).toBe(0);
		expect(performance.now() - started).toBeLessThan(2000);
	});

	test("the startup log redacts userinfo in ZOEKT_URL", async () => {
		const { stderr, exitCode } = await run(["--url", "http://admin:s3cret-pw@127.0.0.1:9"], {
			LOG_LEVEL: "debug",
		});

		expect(exitCode).toBe(0);
		expect(stderr).toContain("Starting zoekt-mcp");
		expect(stderr).toContain("http://***:***@127.0.0.1:9");
		expect(stderr).not.toContain("s3cret-pw");
		expect(stderr).not.toContain("admin");
	});
});

describe("HTTP process", () => {
	test("binds loopback by default, enforces the token, exits 0 on SIGTERM and never logs the token", async () => {
		const port = await freePort();
		const proc = spawn(
			["--url", "http://127.0.0.1:9", "--transport", "http", "--port", String(port)],
			{ MCP_AUTH_TOKEN: TOKEN, LOG_LEVEL: "debug" },
		);
		const log = captureStderr(proc);
		try {
			await log.until((text) => text.includes("listening"));
			const url = `http://127.0.0.1:${port}/mcp`;
			const init = { method: "POST", body: "{}" } as const;
			expect((await fetch(url, init)).status).toBe(401);
			expect(
				(await fetch(url, { ...init, headers: { authorization: `Bearer ${TOKEN}` } })).status,
			).not.toBe(401);
		} finally {
			proc.kill("SIGTERM");
		}
		expect(await proc.exited).toBe(0);
		await log.done;
		expect(log.text).toContain("127.0.0.1");
		expect(log.text).not.toContain(TOKEN);
	});
});
