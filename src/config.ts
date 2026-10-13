import { readFileSync } from "node:fs";
import { z } from "zod";
import { redactUrl } from "./utils.js";

const LogLevelSchema = z.enum(["debug", "info", "warn", "error"], {
	error: "must be one of: debug, info, warn, error",
});
const TransportSchema = z.enum(["http", "stdio"], { error: 'must be "stdio" or "http"' });

const MIN_TOKEN_LENGTH = 16;

/** Defaults shared with createHttpServer so the two layers cannot drift. */
export const DEFAULT_MAX_BODY_BYTES = 1048576;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;

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

/** Comma-separated list of `item`s; blanks are dropped. */
const csvList = <T extends z.ZodType<unknown, string>>(item: T) =>
	z
		.string()
		.transform((value) =>
			value
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean),
		)
		.pipe(z.array(item));

// Bare hostnames only: ports are never pinned, and IPv6 must be bracketed ([::1]).
const HOSTS_MESSAGE =
	"must be comma-separated hostnames without ports (IPv6 in brackets, e.g. [::1]), or *";
const HostsSchema = csvList(
	z
		.string()
		.regex(/^([^\s/:[\]]+|\[[0-9a-f:.]+\])$/i, HOSTS_MESSAGE)
		.transform((host) => host.toLowerCase()),
);

const ORIGINS_MESSAGE =
	"must be a comma-separated list of http(s) origins, e.g. https://app.example.com";
const OriginsSchema = csvList(
	z.string().transform((value, ctx) => {
		try {
			const url = new URL(value);
			if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
		} catch {
			// falls through to the issue below
		}
		ctx.addIssue({ code: "custom", message: ORIGINS_MESSAGE });
		return z.NEVER;
	}),
);

/** Userinfo is percent-decoded into a Basic auth header, so a malformed `%` sequence is a config error. */
function hasValidCredentialEncoding(value: string): boolean {
	try {
		const { username, password } = new URL(value);
		decodeURIComponent(username);
		decodeURIComponent(password);
		return true;
	} catch {
		return false;
	}
}

const ConfigSchema = z.object({
	zoektUrl: z
		.url({
			protocol: /^https?$/,
			error: (issue) =>
				issue.input === undefined
					? "is required"
					: "must be an http:// or https:// URL, e.g. http://localhost:6070",
		})
		.refine(hasValidCredentialEncoding, {
			message: "credentials are not valid percent-encoding",
		}),
	mcpPort: intString(1, 65535, "must be an integer between 1 and 65535").default(3000),
	// node's listen() rejects "[::1]", so bracketed IPv6 literals are stored bare.
	mcpHost: z
		.string()
		.transform((host) => host.replace(/^\[(.*)\]$/, "$1"))
		.default("127.0.0.1"),
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
	).default(DEFAULT_MAX_BODY_BYTES),
	mcpShutdownTimeoutMs: intString(
		0,
		120000,
		"must be an integer between 0 and 120000 (milliseconds)",
	).default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
});

type RawKey = keyof z.input<typeof ConfigSchema>;

/**
 * Where each config key comes from; the inline stand-in for an option registry. Keys with a
 * `flag` also read the CLI value of the same name; the rest are env-only.
 */
const SOURCES: Record<RawKey, { flag?: string; env: string }> = {
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

/** Every environment variable this server reads (the README config table is tested against it). */
export const ENV_KEYS: readonly string[] = [
	...Object.values(SOURCES).map((source) => source.env),
	"MCP_AUTH_TOKEN",
	"MCP_AUTH_TOKEN_FILE",
];

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

/** `localhost`, 127.0.0.0/8 and ::1 (mcpHost is already unbracketed). */
function isLoopbackHost(host: string): boolean {
	const h = host.trim().toLowerCase();
	return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Trimmed value, or undefined when missing, empty or whitespace-only. */
function clean(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** Listening on a non-loopback address with no bearer token. */
export function isExposedWithoutAuth(config: {
	mcpTransport: Transport;
	mcpHost: string;
	mcpAuthToken?: string;
}): boolean {
	return config.mcpTransport === "http" && !isLoopbackHost(config.mcpHost) && !config.mcpAuthToken;
}

export function loadConfig(
	cliArgs: CliArgs = {},
	env: Record<string, string | undefined> = process.env,
): Config {
	// CLI args take precedence over env vars; blank values count as unset.
	const rawConfig = Object.fromEntries(
		(Object.keys(SOURCES) as RawKey[]).map((key) => {
			const { flag, env: envName } = SOURCES[key];
			const cli = flag ? cliArgs[key as keyof CliArgs] : undefined;
			return [key, clean(cli) ?? clean(env[envName])];
		}),
	) as Record<RawKey, string | undefined>;

	const issues: ConfigIssue[] = [];
	const result = ConfigSchema.safeParse(rawConfig);

	if (!result.success) {
		const reported = new Set<string>();
		for (const issue of result.error.issues) {
			const key = issue.path[0] as RawKey;
			if (reported.has(key)) continue;
			reported.add(key);
			const value = rawConfig[key];
			const received = key === "zoektUrl" && value !== undefined ? redactUrl(value) : value;
			issues.push({ ...SOURCES[key], message: issue.message, received });
		}
	}

	const token = resolveToken(env, issues);
	if (!result.success || issues.length > 0) throw new ConfigError(issues);

	const config: Config = { ...result.data, mcpAuthToken: token };
	if (isExposedWithoutAuth(config) && !config.mcpAllowUnauthenticated) {
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
