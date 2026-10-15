import { Command, InvalidArgumentError, Option } from "commander";
import { z } from "zod";
import pkg from "../package.json";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** The only hosts `createMcpHonoApp` protects with Host/Origin validation; anything else needs a token. */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

/** Settings without a flag: secrets stay out of argv, and the rest are deployment details. */
const EnvSchema = z.object({
	MCP_HOST: z.string().default("127.0.0.1"),
	MCP_AUTH_TOKEN: z.string().optional(),
	LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface Config {
	zoektUrl: string;
	transport: "stdio" | "http";
	port: number;
	host: string;
	/** Undefined when auth is off. */
	authToken?: string;
	logLevel: LogLevel;
}

function parseZoektUrl(value: string): string {
	const url = URL.parse(value);
	if (url?.protocol !== "http:" && url?.protocol !== "https:") {
		throw new InvalidArgumentError(
			"must be an http:// or https:// URL, e.g. http://localhost:6070",
		);
	}
	return value;
}

function parsePort(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new InvalidArgumentError("must be an integer between 1 and 65535");
	}
	return port;
}

/** Parses flags (each with an env fallback) and the env-only settings; exits with a message on bad input. */
export function loadConfig(argv: string[] = process.argv): Config {
	const program: Command = new Command()
		.name("zoekt-mcp")
		.description("MCP server for Zoekt code search")
		.version(`${pkg.name} ${pkg.version}`, "-v, --version")
		.addOption(
			new Option("--url <url>", "Zoekt webserver URL")
				.env("ZOEKT_URL")
				.argParser(parseZoektUrl)
				.makeOptionMandatory(),
		)
		.addOption(
			new Option("--transport <mode>", "MCP transport")
				.env("MCP_TRANSPORT")
				.choices(["stdio", "http"])
				.default("stdio"),
		)
		.addOption(
			new Option("--port <number>", "HTTP port").env("MCP_PORT").argParser(parsePort).default(3000),
		)
		.addHelpText(
			"after",
			"\nEnvironment only: MCP_HOST (HTTP bind address, default 127.0.0.1), MCP_AUTH_TOKEN\n(bearer token for /mcp; required for a non-loopback bind), LOG_LEVEL (debug, info, warn, error).",
		)
		.parse(argv);
	const opts = program.opts<{ url: string; transport: Config["transport"]; port: number }>();

	const env = EnvSchema.safeParse(process.env);
	if (!env.success) program.error(z.prettifyError(env.error));
	const { MCP_HOST: host, MCP_AUTH_TOKEN: authToken, LOG_LEVEL: logLevel } = env.data;

	if (opts.transport === "http" && !LOOPBACK_HOSTS.includes(host) && !authToken) {
		program.error(`MCP_HOST=${host} is not a loopback address; set MCP_AUTH_TOKEN to listen on it`);
	}
	return {
		zoektUrl: opts.url,
		transport: opts.transport,
		port: opts.port,
		host,
		authToken,
		logLevel,
	};
}
