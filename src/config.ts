import { readFileSync } from "node:fs";
import { z } from "zod";

const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const TransportSchema = z.enum(["http", "stdio"]);

const MIN_TOKEN_LENGTH = 16;

/** Whole-number string within [min, max]; anything else (incl. "1e3", "0x10", "1.5") fails. */
function intString(min: number, max: number, message: string) {
	return z
		.string({ error: message })
		.regex(/^\d+$/, message)
		.transform(Number)
		.pipe(z.number().int(message).min(min, message).max(max, message));
}

const boolString = (message: string) =>
	z
		.string({ error: message })
		.transform((value) => value.toLowerCase())
		.pipe(z.enum(["true", "false"], { error: message }))
		.transform((value) => value === "true");

const csv = (value: string): string[] =>
	value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

const HostsSchema = z
	.string()
	.transform(csv)
	.pipe(
		z
			.array(z.string().regex(/^[^\s/]+$/))
			.transform((hosts) => hosts.map((host) => host.toLowerCase())),
	);

const OriginsSchema = z
	.string()
	.transform(csv)
	.pipe(
		z.array(
			z.string().transform((value, ctx) => {
				try {
					const url = new URL(value);
					if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
				} catch {
					// falls through to the issue below
				}
				ctx.addIssue({ code: "custom", message: "invalid origin" });
				return z.NEVER;
			}),
		),
	);

const ConfigSchema = z.object({
	zoektUrl: z.url({
		protocol: /^https?$/,
		error: (issue) =>
			issue.input === undefined
				? "is required"
				: "must be an http:// or https:// URL, e.g. http://localhost:6070",
	}),
	mcpPort: intString(1, 65535, "must be an integer between 1 and 65535").default(3000),
	mcpHost: z.string().default("127.0.0.1"),
	mcpTransport: TransportSchema.default("stdio"),
	logLevel: LogLevelSchema.default("info"),
	zoektTimeoutMs: intString(
		1000,
		300000,
		"must be an integer between 1000 and 300000 (milliseconds)",
	).default(30000),
	mcpAllowedHosts: HostsSchema.default([]),
	mcpAllowedOrigins: OriginsSchema.default([]),
	mcpAllowUnauthenticated: boolString('must be "true" or "false"').default(false),
	mcpMaxBodyBytes: intString(
		1024,
		16777216,
		"must be an integer between 1024 and 16777216 (bytes)",
	).default(1048576),
	mcpShutdownTimeoutMs: intString(
		0,
		120000,
		"must be an integer between 0 and 120000 (milliseconds)",
	).default(10000),
});

// Friendly messages that depend on the field rather than the zod issue kind.
const FIELD_MESSAGES: Record<string, string> = {
	mcpTransport: 'must be "stdio" or "http"',
	logLevel: "must be one of: debug, info, warn, error",
	mcpAllowedHosts: "must be a comma-separated list of hostnames (or *)",
	mcpAllowedOrigins:
		"must be a comma-separated list of http(s) origins, e.g. https://app.example.com",
};

/** Where each config key comes from; the inline stand-in for an option registry. */
const SOURCES: Record<string, { flag?: string; env: string }> = {
	zoektUrl: { flag: "--url", env: "ZOEKT_URL" },
	mcpTransport: { flag: "--transport", env: "MCP_TRANSPORT" },
	mcpPort: { flag: "--port", env: "MCP_PORT" },
	mcpHost: { flag: "--host", env: "MCP_HOST" },
	logLevel: { flag: "--log-level", env: "LOG_LEVEL" },
	zoektTimeoutMs: { flag: "--timeout", env: "ZOEKT_TIMEOUT_MS" },
	mcpAllowedHosts: { env: "MCP_ALLOWED_HOSTS" },
	mcpAllowedOrigins: { env: "MCP_ALLOWED_ORIGINS" },
	mcpAllowUnauthenticated: { env: "MCP_ALLOW_UNAUTHENTICATED" },
	mcpMaxBodyBytes: { env: "MCP_MAX_BODY_BYTES" },
	mcpShutdownTimeoutMs: { env: "MCP_SHUTDOWN_TIMEOUT_MS" },
};

export type LogLevel = z.infer<typeof LogLevelSchema>;
export type Transport = z.infer<typeof TransportSchema>;
export type Config = z.output<typeof ConfigSchema> & {
	/** Resolved from MCP_AUTH_TOKEN or MCP_AUTH_TOKEN_FILE; undefined when auth is off. */
	mcpAuthToken?: string;
};

export interface CliArgs {
	zoektUrl?: string;
	mcpTransport?: string;
	mcpPort?: string;
	mcpHost?: string;
	logLevel?: string;
	zoektTimeoutMs?: string;
}

export interface ConfigIssue {
	flag?: string;
	env: string;
	message: string;
	received?: string;
}

/** Human-readable stderr text; never JSON, never a zod dump. */
export function formatConfigError(error: { issues: ConfigIssue[] }): string {
	const lines = error.issues.map(({ flag, env, message, received }) => {
		const name = flag ? `${flag} / ${env}` : env;
		return `  ${name}: ${message}${received !== undefined ? ` (got "${received}")` : ""}`;
	});
	return ["zoekt-mcp: invalid configuration", ...lines, 'Run "zoekt-mcp --help" for usage.'].join(
		"\n",
	);
}

export class ConfigError extends Error {
	constructor(readonly issues: ConfigIssue[]) {
		super(formatConfigError({ issues }));
		this.name = "ConfigError";
	}
}

/** `localhost`, 127.0.0.0/8 and ::1 (bracketed or not). */
export function isLoopbackHost(host: string): boolean {
	const h = host.trim().toLowerCase();
	return h === "localhost" || h === "::1" || h === "[::1]" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Trimmed value, or undefined when missing, empty or whitespace-only. */
function clean(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function loadConfig(
	cliArgs: CliArgs = {},
	env: Record<string, string | undefined> = process.env,
): Config {
	// CLI args take precedence over env vars; blank values count as unset.
	const get = (cli: string | undefined, key: string) => clean(cli) ?? clean(env[key]);
	const rawConfig = {
		zoektUrl: get(cliArgs.zoektUrl, "ZOEKT_URL"),
		mcpPort: get(cliArgs.mcpPort, "MCP_PORT"),
		mcpHost: get(cliArgs.mcpHost, "MCP_HOST"),
		mcpTransport: get(cliArgs.mcpTransport, "MCP_TRANSPORT"),
		logLevel: get(cliArgs.logLevel, "LOG_LEVEL"),
		zoektTimeoutMs: get(cliArgs.zoektTimeoutMs, "ZOEKT_TIMEOUT_MS"),
		mcpAllowedHosts: clean(env.MCP_ALLOWED_HOSTS),
		mcpAllowedOrigins: clean(env.MCP_ALLOWED_ORIGINS),
		mcpAllowUnauthenticated: clean(env.MCP_ALLOW_UNAUTHENTICATED),
		mcpMaxBodyBytes: clean(env.MCP_MAX_BODY_BYTES),
		mcpShutdownTimeoutMs: clean(env.MCP_SHUTDOWN_TIMEOUT_MS),
	};

	const issues: ConfigIssue[] = [];
	const result = ConfigSchema.safeParse(rawConfig);

	if (!result.success) {
		const reported = new Set<string>();
		for (const issue of result.error.issues) {
			const key = String(issue.path[0]);
			if (reported.has(key)) continue;
			reported.add(key);
			const received = rawConfig[key as keyof typeof rawConfig];
			const missing = key === "zoektUrl" && received === undefined;
			issues.push({
				...(SOURCES[key] ?? { env: key }),
				message: missing ? "is required" : (FIELD_MESSAGES[key] ?? issue.message),
				received: missing ? undefined : received,
			});
		}
	}

	const token = resolveToken(env, issues);
	if (!result.success || issues.length > 0) throw new ConfigError(issues);

	const config: Config = { ...result.data, mcpAuthToken: token };
	if (
		config.mcpTransport === "http" &&
		!isLoopbackHost(config.mcpHost) &&
		!token &&
		!config.mcpAllowUnauthenticated
	) {
		throw new ConfigError([
			{
				...SOURCES.mcpHost,
				env: "MCP_HOST",
				message:
					"refusing to listen on a non-loopback address without authentication; set MCP_AUTH_TOKEN " +
					"(or MCP_AUTH_TOKEN_FILE), or MCP_ALLOW_UNAUTHENTICATED=true to opt out",
				received: config.mcpHost,
			},
		]);
	}
	return config;
}

function resolveToken(
	env: Record<string, string | undefined>,
	issues: ConfigIssue[],
): string | undefined {
	const inline = clean(env.MCP_AUTH_TOKEN);
	const file = clean(env.MCP_AUTH_TOKEN_FILE);

	if (inline && file) {
		issues.push({
			env: "MCP_AUTH_TOKEN / MCP_AUTH_TOKEN_FILE",
			message: "are mutually exclusive; set only one",
		});
		return undefined;
	}

	let token = inline;
	let source = "MCP_AUTH_TOKEN";
	if (file) {
		source = "MCP_AUTH_TOKEN_FILE";
		try {
			token = readFileSync(file, "utf8").trim();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
			issues.push({ env: source, message: `could not read token file (${code})`, received: file });
			return undefined;
		}
	}

	if (token !== undefined && token.length < MIN_TOKEN_LENGTH) {
		issues.push({ env: source, message: `token must be at least ${MIN_TOKEN_LENGTH} characters` });
		return undefined;
	}
	return token;
}
