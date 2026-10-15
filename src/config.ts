import { readFileSync } from "node:fs";
import { z } from "zod";
import { redactUrl } from "./utils.js";

const LogLevelSchema = z.enum(["debug", "info", "warn", "error"], {
	error: "must be one of: debug, info, warn, error",
});
const TransportSchema = z.enum(["http", "stdio"], { error: 'must be "stdio" or "http"' });

const MIN_TOKEN_LENGTH = 16;

const PORT_MESSAGE = "must be an integer between 1 and 65535";

// Bare hostnames only: ports are never pinned, and IPv6 must be bracketed ([::1]).
const HOSTS_MESSAGE =
	"must be comma-separated hostnames without ports (IPv6 in brackets, e.g. [::1])";
const HostsSchema = z
	.string()
	.transform((value) =>
		value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
	)
	.pipe(
		z.array(
			z
				.string()
				.regex(/^([^\s/:[\]*]+|\[[0-9a-f:.]+\])$/i, HOSTS_MESSAGE)
				.transform((host) => host.toLowerCase()),
		),
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
	// Whole-number string only: "1e3", "0x10" and "1.5" all fail.
	mcpPort: z
		.string({ error: PORT_MESSAGE })
		.regex(/^\d+$/, PORT_MESSAGE)
		.transform(Number)
		.pipe(z.number().int(PORT_MESSAGE).min(1, PORT_MESSAGE).max(65535, PORT_MESSAGE))
		.default(3000),
	mcpHost: z.string().default("127.0.0.1"),
	mcpTransport: TransportSchema.default("stdio"),
	logLevel: LogLevelSchema.default("info"),
	mcpAllowedHosts: HostsSchema.default([]),
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
	mcpAllowedHosts: { env: "MCP_ALLOWED_HOSTS" },
};

export type LogLevel = z.infer<typeof LogLevelSchema>;
export type Transport = z.infer<typeof TransportSchema>;
type Config = z.output<typeof ConfigSchema> & {
	/** Resolved from MCP_AUTH_TOKEN or MCP_AUTH_TOKEN_FILE; undefined when auth is off. */
	mcpAuthToken?: string;
};

interface CliArgs {
	zoektUrl?: string;
	mcpTransport?: string;
	mcpPort?: string;
	mcpHost?: string;
	logLevel?: string;
}

interface ConfigIssue {
	flag?: string;
	env: string;
	message: string;
	received?: string;
}

/** Human-readable stderr text; never JSON, never a zod dump. */
function configError(issues: ConfigIssue[]): Error {
	const lines = issues.map(({ flag, env, message, received }) => {
		const name = flag ? `${flag} / ${env}` : env;
		return `  ${name}: ${message}${received !== undefined ? ` (got "${received}")` : ""}`;
	});
	return new Error(
		["zoekt-mcp: invalid configuration", ...lines, 'Run "zoekt-mcp --help" for usage.'].join("\n"),
	);
}

/** `localhost`, 127.0.0.0/8 and ::1. */
function isLoopbackHost(host: string): boolean {
	const h = host.toLowerCase();
	return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
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
	if (!result.success || issues.length > 0) throw configError(issues);

	const config: Config = { ...result.data, mcpAuthToken: token };
	if (config.mcpTransport === "http" && !isLoopbackHost(config.mcpHost) && !token) {
		throw configError([
			{
				...SOURCES.mcpHost,
				message:
					"refusing to listen on a non-loopback address without authentication; set MCP_AUTH_TOKEN " +
					"(or MCP_AUTH_TOKEN_FILE)",
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
