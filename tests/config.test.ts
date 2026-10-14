import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, formatConfigError, loadConfig } from "../src/config.js";

const URL_ENV = { ZOEKT_URL: "http://x" };
const TOKEN = "0123456789abcdef-token";

function issuesOf(fn: () => unknown): ConfigError["issues"] {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		return (error as ConfigError).issues;
	}
	throw new Error("expected loadConfig to throw");
}

describe("transport and precedence", () => {
	test("CLI value beats env value", () => {
		const config = loadConfig({ mcpTransport: "stdio" }, { ...URL_ENV, MCP_TRANSPORT: "http" });
		expect(config.mcpTransport).toBe("stdio");
	});

	test("env beats default", () => {
		expect(loadConfig({}, { ...URL_ENV, MCP_TRANSPORT: "http" }).mcpTransport).toBe("http");
		expect(loadConfig({}, { ...URL_ENV, MCP_PORT: "8080" }).mcpPort).toBe(8080);
	});

	test("empty and whitespace-only env values are treated as unset", () => {
		const config = loadConfig({}, { ...URL_ENV, MCP_TRANSPORT: "", MCP_PORT: "  " });
		expect(config.mcpTransport).toBe("stdio");
		expect(config.mcpPort).toBe(3000);

		const issues = issuesOf(() => loadConfig({}, { ZOEKT_URL: "" }));
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({ flag: "--url", env: "ZOEKT_URL", message: "is required" });
	});
});

describe("zoekt url", () => {
	test("rejects non-http(s) URLs", () => {
		for (const bad of ["ftp://h", "file:///etc/passwd", "javascript:alert(1)", "localhost:6070"]) {
			const issues = issuesOf(() => loadConfig({}, { ZOEKT_URL: bad }));
			expect(issues).toHaveLength(1);
			expect(issues[0]?.env).toBe("ZOEKT_URL");
			expect(issues[0]?.message).toContain("must be an http:// or https:// URL");
			expect(issues[0]?.received).toBe(bad);
		}
	});

	test("never echoes credentials in a rejected ZOEKT_URL", () => {
		for (const bad of ["ftp://u:s3cret@x", "u:s3cret@", "//u:s3cret@host", "ftp://s3cret@x"]) {
			let error: unknown;
			try {
				loadConfig({}, { ZOEKT_URL: bad });
			} catch (e) {
				error = e;
			}
			expect(error).toBeInstanceOf(ConfigError);
			expect(formatConfigError(error as ConfigError)).not.toContain("s3cret");
		}
	});

	test("a malformed percent sequence in credentials is a config error that hides the value", () => {
		const issues = issuesOf(() => loadConfig({}, { ZOEKT_URL: "http://u:s3%ZZcret@127.0.0.1:1" }));
		expect(issues[0]?.message).toBe("credentials are not valid percent-encoding");
		expect(JSON.stringify(issues)).not.toContain("s3");
		expect(loadConfig({}, { ZOEKT_URL: "http://u:p%40ss@h:1" }).zoektUrl).toContain("p%40ss");
	});

	test("accepts https with port and path", () => {
		const config = loadConfig({}, { ZOEKT_URL: "https://zoekt.example.com:6070/base" });
		expect(config.zoektUrl).toBe("https://zoekt.example.com:6070/base");
	});
});

describe("error reporting", () => {
	test("reports every invalid option at once", () => {
		let error: unknown;
		try {
			loadConfig({ mcpPort: "abc" }, { ...URL_ENV, ZOEKT_TIMEOUT_MS: "5" });
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(ConfigError);
		const issues = (error as ConfigError).issues;
		expect(issues).toHaveLength(2);

		const text = formatConfigError(error as ConfigError);
		expect(text).toStartWith("zoekt-mcp: invalid configuration");
		expect(text).toContain('--port / MCP_PORT: must be an integer between 1 and 65535 (got "abc")');
		expect(text).toContain("--timeout / ZOEKT_TIMEOUT_MS");
		expect(text).toContain('Run "zoekt-mcp --help" for usage.');
		expect(text).not.toContain("ZodError");
		expect(text).not.toContain("{");
	});

	test("friendly messages for transport and log level", () => {
		const text = formatConfigError({
			issues: issuesOf(() =>
				loadConfig({}, { ...URL_ENV, MCP_TRANSPORT: "sse", LOG_LEVEL: "loud" }),
			),
		});
		expect(text).toContain('--transport / MCP_TRANSPORT: must be "stdio" or "http" (got "sse")');
		expect(text).toContain("--log-level / LOG_LEVEL: must be one of: debug, info, warn, error");
	});
});

describe("HTTP security keys", () => {
	test("defaults", () => {
		const config = loadConfig({}, URL_ENV);
		expect(config).toMatchObject({
			mcpTransport: "stdio",
			mcpHost: "127.0.0.1",
			mcpAllowedHosts: [],
			mcpAllowedOrigins: [],
			mcpAllowUnauthenticated: false,
			mcpAuthToken: undefined,
		});
	});

	test("parses csv lists and normalizes origins", () => {
		const config = loadConfig(
			{},
			{
				...URL_ENV,
				MCP_ALLOWED_HOSTS: " Mcp.Example.com , ,10.0.0.5 ",
				MCP_ALLOWED_ORIGINS: "https://app.example.com/,http://localhost:5173",
			},
		);
		expect(config.mcpAllowedHosts).toEqual(["mcp.example.com", "10.0.0.5"]);
		expect(config.mcpAllowedOrigins).toEqual(["https://app.example.com", "http://localhost:5173"]);
	});

	test("rejects malformed origins, bounds and booleans", () => {
		const issues = issuesOf(() =>
			loadConfig(
				{},
				{
					...URL_ENV,
					MCP_ALLOWED_ORIGINS: "not-an-origin",
					MCP_ALLOW_UNAUTHENTICATED: "yes",
				},
			),
		);
		expect(issues.map((i) => i.env).sort()).toEqual([
			"MCP_ALLOWED_ORIGINS",
			"MCP_ALLOW_UNAUTHENTICATED",
		]);
	});

	test("MCP_ALLOWED_HOSTS rejects entries with a port or an unbracketed IPv6 address", () => {
		for (const bad of ["foo:80", "::1", "*", "a.example,b.example:8443", "https://a.example"]) {
			const issues = issuesOf(() => loadConfig({}, { ...URL_ENV, MCP_ALLOWED_HOSTS: bad }));
			expect(issues).toHaveLength(1);
			expect(issues[0]?.env).toBe("MCP_ALLOWED_HOSTS");
			expect(issues[0]?.message).toContain("without ports");
		}
		const ok = loadConfig({}, { ...URL_ENV, MCP_ALLOWED_HOSTS: "a.example,[::1]" });
		expect(ok.mcpAllowedHosts).toEqual(["a.example", "[::1]"]);
	});

	describe("token", () => {
		let dir: string;
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "zoekt-mcp-token-"));
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));

		test("MCP_AUTH_TOKEN_FILE is read and trimmed", () => {
			const file = join(dir, "token");
			writeFileSync(file, `  ${TOKEN}\n`);
			expect(loadConfig({}, { ...URL_ENV, MCP_AUTH_TOKEN_FILE: file }).mcpAuthToken).toBe(TOKEN);
		});

		test("token < 16 chars is a config error", () => {
			const issues = issuesOf(() => loadConfig({}, { ...URL_ENV, MCP_AUTH_TOKEN: "short" }));
			expect(issues).toHaveLength(1);
			expect(issues[0]?.env).toBe("MCP_AUTH_TOKEN");
			expect(JSON.stringify(issues)).not.toContain("short");

			const file = join(dir, "short");
			writeFileSync(file, "short\n");
			expect(
				issuesOf(() => loadConfig({}, { ...URL_ENV, MCP_AUTH_TOKEN_FILE: file }))[0]?.env,
			).toBe("MCP_AUTH_TOKEN_FILE");
		});

		test("both token vars set is a config error", () => {
			const issues = issuesOf(() =>
				loadConfig({}, { ...URL_ENV, MCP_AUTH_TOKEN: TOKEN, MCP_AUTH_TOKEN_FILE: join(dir, "t") }),
			);
			expect(issues[0]?.message).toContain("mutually exclusive");
		});

		test("unreadable token file is a config error", () => {
			const issues = issuesOf(() =>
				loadConfig({}, { ...URL_ENV, MCP_AUTH_TOKEN_FILE: join(dir, "missing") }),
			);
			expect(issues[0]?.message).toContain("could not read token file");
		});
	});

	describe("non-loopback bind", () => {
		const http = { ...URL_ENV, MCP_TRANSPORT: "http" };

		test("without a token refuses to start and names MCP_AUTH_TOKEN", () => {
			for (const host of ["0.0.0.0", "10.1.2.3", "::", "example.com"]) {
				const issues = issuesOf(() => loadConfig({}, { ...http, MCP_HOST: host }));
				expect(issues[0]?.message).toContain("MCP_AUTH_TOKEN");
			}
		});

		test("loopback names are always allowed", () => {
			for (const host of ["localhost", "127.0.0.1", "127.9.9.9", "::1"]) {
				expect(loadConfig({}, { ...http, MCP_HOST: host }).mcpHost).toBe(host);
			}
		});

		test("a token or MCP_ALLOW_UNAUTHENTICATED=true lets it start", () => {
			const withToken = loadConfig({}, { ...http, MCP_HOST: "0.0.0.0", MCP_AUTH_TOKEN: TOKEN });
			expect(withToken.mcpAuthToken).toBe(TOKEN);
			const optOut = loadConfig(
				{},
				{ ...http, MCP_HOST: "0.0.0.0", MCP_ALLOW_UNAUTHENTICATED: "true" },
			);
			expect(optOut.mcpAllowUnauthenticated).toBe(true);
		});

		test("stdio never binds, so it is not refused", () => {
			expect(loadConfig({}, { ...URL_ENV, MCP_HOST: "0.0.0.0" }).mcpTransport).toBe("stdio");
		});
	});
});
