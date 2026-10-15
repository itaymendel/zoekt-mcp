import { describe, expect, test } from "bun:test";
import { run, spawn } from "./helpers/cli.js";

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

describe("configuration errors", () => {
	const cases: Array<[string, string[], Record<string, string>, string]> = [
		["a missing URL", [], {}, "required option '--url <url>'"],
		["a non-http URL", ["--url", "ftp://x"], {}, "must be an http:// or https:// URL"],
		["an unknown transport", ["--url", "http://x", "--transport", "sse"], {}, "Allowed choices"],
		["a bad port", ["--url", "http://x", "--port", "0"], {}, "between 1 and 65535"],
		["a bad log level", ["--url", "http://x"], { LOG_LEVEL: "loud" }, "LOG_LEVEL"],
		[
			"a non-loopback bind without a token",
			["--url", "http://x", "--transport", "http"],
			{ MCP_HOST: "0.0.0.0" },
			"set MCP_AUTH_TOKEN",
		],
	];

	test.each(cases)("%s exits 1 with a readable message", async (_name, args, env, message) => {
		const { stderr, exitCode } = await run(args, env);

		expect(exitCode).toBe(1);
		expect(stderr).toContain(message);
	});

	test("a rejected URL never echoes its credentials or query secrets", async () => {
		for (const bad of [
			"ftp://admin:s3cret@host",
			"admin:s3cret@host",
			"ftp://host/?token=s3cret",
		]) {
			const flag = await run(["--url", bad]);
			const env = await run([], { ZOEKT_URL: bad });

			for (const { stderr, exitCode } of [flag, env]) {
				expect(exitCode).toBe(1);
				expect(stderr).toContain("must be an http:// or https:// URL");
				expect(stderr).not.toContain("s3cret");
			}
		}
	});

	test("the URL can come from ZOEKT_URL", async () => {
		const { exitCode } = await run([], { ZOEKT_URL: "http://127.0.0.1:9" });

		expect(exitCode).toBe(0);
	});
});

describe("HTTP process", () => {
	test("serves /healthz and exits 0 on SIGTERM", async () => {
		const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
		const port = probe.port as number;
		await probe.stop(true);

		const proc = spawn([
			"--url",
			"http://127.0.0.1:9",
			"--transport",
			"http",
			"--port",
			String(port),
		]);
		try {
			let status = 0;
			for (let i = 0; i < 80 && status !== 200; i++) {
				status = await fetch(`http://127.0.0.1:${port}/healthz`).then(
					(res) => res.status,
					() => 0,
				);
				if (status !== 200) await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(status).toBe(200);
		} finally {
			proc.kill("SIGTERM");
		}
		expect(await proc.exited).toBe(0);
	});
});
