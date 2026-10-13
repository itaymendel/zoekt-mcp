import { z } from "zod";

const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const TransportSchema = z.enum(["http", "stdio"]);

const ConfigSchema = z.object({
	zoektUrl: z.url({
		error: (issue) =>
			issue.input === undefined ? "ZOEKT_URL (or --url) is required" : "must be a valid URL",
	}),
	mcpPort: z.coerce.number().int().min(1).max(65535).default(3000),
	mcpHost: z.string().default("0.0.0.0"),
	mcpTransport: TransportSchema.default("http"),
	logLevel: LogLevelSchema.default("info"),
	zoektTimeoutMs: z.coerce.number().int().min(1000).max(300000).default(30000),
});

export type Config = z.infer<typeof ConfigSchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;
export type Transport = z.infer<typeof TransportSchema>;

export interface CliArgs {
	zoektUrl?: string;
	mcpTransport?: string;
	mcpPort?: string;
	mcpHost?: string;
	logLevel?: string;
	zoektTimeoutMs?: string;
}

function detectTransport(): Transport {
	const isPipedInput = !process.stdin.isTTY;
	return isPipedInput ? "stdio" : "http";
}

function getEnv(key: string): string | undefined {
	return process.env[key];
}

export function loadConfig(cliArgs: CliArgs = {}): Config {
	// CLI args take precedence over env vars
	const rawConfig = {
		zoektUrl: cliArgs.zoektUrl ?? getEnv("ZOEKT_URL"),
		mcpPort: cliArgs.mcpPort ?? getEnv("MCP_PORT"),
		mcpHost: cliArgs.mcpHost ?? getEnv("MCP_HOST"),
		mcpTransport: cliArgs.mcpTransport ?? getEnv("MCP_TRANSPORT") ?? detectTransport(),
		logLevel: cliArgs.logLevel ?? getEnv("LOG_LEVEL"),
		zoektTimeoutMs: cliArgs.zoektTimeoutMs ?? getEnv("ZOEKT_TIMEOUT_MS"),
	};

	const result = ConfigSchema.safeParse(rawConfig);

	if (!result.success) {
		const errors = result.error.issues.map((e) => `  ${e.path.join(".")}: ${e.message}`).join("\n");
		throw new Error(`Configuration validation failed:\n${errors}`);
	}

	return result.data;
}
