import { describe, expect, test } from "bun:test";

const ENTRY = "src/index.ts";
const TOKEN = "0123456789abcdef-secret";

type Spawned = ReturnType<typeof spawn>;

function spawn(args: string[], env: Record<string, string> = {}) {
	return Bun.spawn(["bun", ENTRY, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		// Start from a clean slate so the host's ZOEKT_URL/MCP_* never leak into a test.
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
	});
}

async function run(args: string[], env: Record<string, string> = {}) {
	const proc = spawn(args, env);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

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
	test("non-http(s) ZOEKT_URL prints a readable header and exits 2", async () => {
		const { stdout, stderr, exitCode } = await run([], { ZOEKT_URL: "ftp://x" });

		expect(exitCode).toBe(2);
		expect(stdout).toBe("");
		expect(stderr).toStartWith("zoekt-mcp: invalid configuration");
		expect(stderr).not.toContain("{");
	});

	test("a missing URL exits 2 and names --url / ZOEKT_URL", async () => {
		const { stderr, exitCode } = await run([]);

		expect(exitCode).toBe(2);
		expect(stderr).toContain("--url / ZOEKT_URL: is required");
	});

	test("an unknown option exits 2", async () => {
		const { stderr, exitCode } = await run(["--bogus"]);

		expect(exitCode).toBe(2);
		expect(stderr).toContain("Unknown option");
	});

	test("stdio is the default: exits 0 on EOF without TTY detection", async () => {
		const started = performance.now();
		const { exitCode } = await run(["--url", "http://127.0.0.1:9"]);

		expect(exitCode).toBe(0);
		expect(performance.now() - started).toBeLessThan(2000);
	});

	test("--help documents stdio as the default and no auto-detect", async () => {
		const { stdout, exitCode } = await run(["--help"]);

		expect(exitCode).toBe(0);
		expect(stdout).toContain('"stdio" (default)');
		expect(stdout).not.toContain("auto-detect");
		expect(stdout).toContain("MCP_AUTH_TOKEN");
	});
});

describe("non-loopback bind", () => {
	const base = ["--url", "http://127.0.0.1:9", "--transport", "http"];

	test("non-loopback bind without token refuses to start (exit 2)", async () => {
		const { stderr, exitCode } = await run([...base, "--port", "3999"], { MCP_HOST: "0.0.0.0" });

		expect(exitCode).toBe(2);
		expect(stderr).toStartWith("zoekt-mcp: invalid configuration");
		expect(stderr).toContain("MCP_AUTH_TOKEN");
	});

	test("MCP_ALLOW_UNAUTHENTICATED=true starts and logs warn", async () => {
		const port = await freePort();
		const proc = spawn([...base, "--port", String(port)], {
			MCP_HOST: "0.0.0.0",
			MCP_ALLOW_UNAUTHENTICATED: "true",
		});
		const log = captureStderr(proc);
		try {
			const stderr = await log.until((text) => text.includes("listening"));
			expect(stderr).toContain("without authentication");
			expect(stderr).toContain('"level":40');
			expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
		} finally {
			proc.kill("SIGTERM");
			expect(await proc.exited).toBe(0);
		}
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
