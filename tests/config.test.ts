import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";

const URL_ENV = { ZOEKT_URL: "http://x" };
const TOKEN = "0123456789abcdef-token";

/** The formatted stderr text of the error loadConfig throws. */
function errorOf(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected loadConfig to throw");
}

/** Number of reported option lines in a formatted config error. */
const issueCount = (text: string) => text.split("\n").length - 2;

describe("transport and precedence", () => {
	test("CLI beats env, env beats default", () => {
		const env = { ...URL_ENV, MCP_TRANSPORT: "http", MCP_PORT: "8080" };
		expect(loadConfig({ mcpTransport: "stdio" }, env).mcpTransport).toBe("stdio");
		expect(loadConfig({}, env).mcpTransport).toBe("http");
		expect(loadConfig({}, env).mcpPort).toBe(8080);
	});

	test("empty and whitespace-only env values are treated as unset", () => {
		const config = loadConfig({}, { ...URL_ENV, MCP_TRANSPORT: "", MCP_PORT: "  " });
		expect(config.mcpTransport).toBe("stdio");
		expect(config.mcpPort).toBe(3000);

		const text = errorOf(() => loadConfig({}, { ZOEKT_URL: "" }));
		expect(issueCount(text)).toBe(1);
		expect(text).toContain("--url / ZOEKT_URL: is required");
	});
});

describe("zoekt url", () => {
	test("rejects non-http(s) URLs", () => {
		for (const bad of ["ftp://h", "file:///etc/passwd", "javascript:alert(1)", "localhost:6070"]) {
			const text = errorOf(() => loadConfig({}, { ZOEKT_URL: bad }));
			expect(issueCount(text)).toBe(1);
			expect(text).toContain(
				`ZOEKT_URL: must be an http:// or https:// URL, e.g. http://localhost:6070 (got "${bad}")`,
			);
		}
	});

	test("never echoes credentials in a rejected ZOEKT_URL", () => {
		for (const bad of ["ftp://u:s3cret@x", "u:s3cret@", "//u:s3cret@host", "ftp://s3cret@x"]) {
			expect(errorOf(() => loadConfig({}, { ZOEKT_URL: bad }))).not.toContain("s3cret");
		}
	});

	test("a malformed percent sequence in credentials is a config error that hides the value", () => {
		const text = errorOf(() => loadConfig({}, { ZOEKT_URL: "http://u:s3%ZZcret@127.0.0.1:1" }));
		expect(text).toContain("credentials are not valid percent-encoding");
		expect(text).not.toContain("s3");
		expect(loadConfig({}, { ZOEKT_URL: "http://u:p%40ss@h:1" }).zoektUrl).toContain("p%40ss");
	});
});

describe("error reporting", () => {
	test("reports every invalid option at once", () => {
		const text = errorOf(() =>
			loadConfig({ mcpPort: "abc" }, { ...URL_ENV, MCP_TRANSPORT: "sse" }),
		);
		expect(issueCount(text)).toBe(2);
		expect(text).toStartWith("zoekt-mcp: invalid configuration");
		expect(text).toContain('--port / MCP_PORT: must be an integer between 1 and 65535 (got "abc")');
		expect(text).toContain('--transport / MCP_TRANSPORT: must be "stdio" or "http" (got "sse")');
		expect(text).toContain('Run "zoekt-mcp --help" for usage.');
		expect(text).not.toContain("ZodError");
		expect(text).not.toContain("{");
	});
});

describe("HTTP security keys", () => {
	test("HTTP binds loopback and requires auth by default", () => {
		const config = loadConfig({}, URL_ENV);
		expect(config.mcpHost).toBe("127.0.0.1");
		expect(config.mcpAuthToken).toBeUndefined();
	});

	test("MCP_ALLOWED_HOSTS is normalized and rejects entries with a port or an unbracketed IPv6 address", () => {
		for (const bad of ["foo:80", "::1", "*", "a.example,b.example:8443", "https://a.example"]) {
			const text = errorOf(() => loadConfig({}, { ...URL_ENV, MCP_ALLOWED_HOSTS: bad }));
			expect(issueCount(text)).toBe(1);
			expect(text).toContain("MCP_ALLOWED_HOSTS: must be comma-separated hostnames without ports");
		}
		const ok = loadConfig({}, { ...URL_ENV, MCP_ALLOWED_HOSTS: " A.example , ,[::1] " });
		expect(ok.mcpAllowedHosts).toEqual(["a.example", "[::1]"]);
	});

	test("token < 16 chars is a config error", () => {
		const text = errorOf(() => loadConfig({}, { ...URL_ENV, MCP_AUTH_TOKEN: "short" }));
		expect(issueCount(text)).toBe(1);
		expect(text).toContain("MCP_AUTH_TOKEN: token must be at least 16 characters");
		expect(text).not.toContain("short");
	});

	describe("non-loopback bind", () => {
		const http = { ...URL_ENV, MCP_TRANSPORT: "http" };

		test("without a token refuses to start and names MCP_AUTH_TOKEN", () => {
			for (const host of ["0.0.0.0", "10.1.2.3", "::", "example.com"]) {
				const text = errorOf(() => loadConfig({}, { ...http, MCP_HOST: host }));
				expect(text).toContain("set MCP_AUTH_TOKEN");
			}
		});

		test("loopback names are always allowed", () => {
			for (const host of ["localhost", "127.0.0.1", "127.9.9.9", "::1"]) {
				expect(loadConfig({}, { ...http, MCP_HOST: host }).mcpHost).toBe(host);
			}
		});

		test("a token lets it start", () => {
			const config = loadConfig({}, { ...http, MCP_HOST: "0.0.0.0", MCP_AUTH_TOKEN: TOKEN });
			expect(config.mcpAuthToken).toBe(TOKEN);
		});
	});
});
