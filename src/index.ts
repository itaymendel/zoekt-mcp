#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import pkg from "../package.json";
import type { Config } from "./config.js";
import { ConfigError, formatConfigError, isExposedWithoutAuth, loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { createServerFactory } from "./server.js";
import { getErrorMessage, redactUrl } from "./utils.js";
import { ZoektClient } from "./zoekt/client.js";

// Best-effort: only reachable on a Node old enough to still parse and load the imports above.
if (Number(process.versions.node.split(".")[0]) < 22) {
	console.error("zoekt-mcp requires Node.js >= 22");
	process.exit(2);
}

function printHelp(): void {
	console.log(`
zoekt-mcp - MCP server for Zoekt code search

USAGE:
  zoekt-mcp [OPTIONS]
  npx zoekt-mcp [OPTIONS]

OPTIONS:
  --url <url>          Zoekt webserver URL (required, or set ZOEKT_URL)
  --transport <mode>   Transport mode: "stdio" (default) or "http"
  --port <number>      HTTP server port (default: 3000)
  --host <address>     HTTP server host (default: 127.0.0.1)
  --log-level <level>  Log level: debug, info, warn, error (default: info)
  --timeout <ms>       Zoekt request timeout in ms (default: 30000)
  --help, -h           Show this help message
  --version, -v        Show version

EXAMPLES:
  zoekt-mcp --url http://localhost:6070
  zoekt-mcp --url http://localhost:6070 --transport stdio
  zoekt-mcp --url http://localhost:6070 --transport http --port 8080 --log-level debug

ENVIRONMENT VARIABLES:
  ZOEKT_URL                   Zoekt webserver URL (http:// or https://)
  MCP_TRANSPORT               Transport mode (stdio or http; default stdio)
  MCP_PORT                    HTTP server port
  MCP_HOST                    HTTP server host (default 127.0.0.1)
  MCP_ALLOWED_HOSTS           Extra Host header hostnames, comma-separated ("*" disables the check)
  MCP_ALLOWED_ORIGINS         Extra allowed browser origins, comma-separated (also granted CORS)
  MCP_AUTH_TOKEN              Require "Authorization: Bearer <token>" on /mcp (min 16 chars)
  MCP_AUTH_TOKEN_FILE         Read the bearer token from a file (exclusive with MCP_AUTH_TOKEN)
  MCP_ALLOW_UNAUTHENTICATED   Set to "true" to listen on a non-loopback host without a token
  MCP_MAX_BODY_BYTES          Largest /mcp request body (default 1048576)
  MCP_SHUTDOWN_TIMEOUT_MS     Grace period before dropping connections on shutdown (default 10000)
  LOG_LEVEL                   Log level
  ZOEKT_TIMEOUT_MS            Request timeout in milliseconds

EXIT CODES:
  0 ok, 1 runtime failure, 2 usage or configuration error
`);
}

/** A bad command line; reported on stderr with exit code 2. */
class UsageError extends Error {}

function parseCliArgs(): Record<string, string | undefined> {
	try {
		const { values } = parseArgs({
			options: {
				url: { type: "string" },
				transport: { type: "string" },
				port: { type: "string" },
				host: { type: "string" },
				"log-level": { type: "string" },
				timeout: { type: "string" },
				help: { type: "boolean", short: "h" },
				version: { type: "boolean", short: "v" },
			},
			strict: true,
		});

		if (values.help) {
			printHelp();
			process.exit(0);
		}

		if (values.version) {
			console.log(`${pkg.name} ${pkg.version}`);
			process.exit(0);
		}

		return {
			zoektUrl: values.url,
			mcpTransport: values.transport,
			mcpPort: values.port,
			mcpHost: values.host,
			logLevel: values["log-level"],
			zoektTimeoutMs: values.timeout,
		};
	} catch (error) {
		if (String((error as NodeJS.ErrnoException).code).startsWith("ERR_PARSE_ARGS")) {
			throw new UsageError((error as Error).message);
		}
		throw error;
	}
}

async function main(): Promise<void> {
	let logger = createLogger("info");

	try {
		const cliArgs = parseCliArgs();
		const config = loadConfig(cliArgs);
		logger = createLogger(config.logLevel);

		logger.info(
			{ transport: config.mcpTransport, zoektUrl: redactUrl(config.zoektUrl) },
			"Starting zoekt-mcp",
		);

		// Built once; the factory below runs per request (HTTP) or per connection (stdio).
		const client = new ZoektClient({
			baseUrl: config.zoektUrl,
			timeoutMs: config.zoektTimeoutMs,
			logger,
		});
		const createServer = createServerFactory({
			client,
			logger,
			authRequired: config.mcpAuthToken !== undefined,
		});

		if (config.mcpTransport === "stdio") {
			await startStdioTransport(createServer, logger);
		} else {
			await startHttpTransport(createServer, config, logger);
		}
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`Error: ${error.message}`);
			console.error('Run "zoekt-mcp --help" for usage information.');
			process.exit(2);
		}
		if (error instanceof ConfigError) {
			console.error(formatConfigError(error));
			process.exit(2);
		}
		logger.error({ error: getErrorMessage(error) }, "Fatal error");
		process.exit(1);
	}
}

/** One handler for both signals: exit 0 when clean, 1 when forced or failed; a second signal exits 1. */
function onShutdown(close: () => Promise<{ forced: boolean }>, logger: Logger): void {
	let shuttingDown = false;
	const handle = (signal: string) => {
		if (shuttingDown) {
			logger.warn(`Received ${signal} again, exiting immediately`);
			process.exit(1);
		}
		shuttingDown = true;
		logger.info(`Received ${signal}, shutting down`);
		close().then(
			(result) => {
				if (result.forced) logger.warn("forced shutdown");
				process.exit(result.forced ? 1 : 0);
			},
			(error) => {
				logger.error({ error: getErrorMessage(error) }, "Shutdown failed");
				process.exit(1);
			},
		);
	};
	process.on("SIGINT", handle);
	process.on("SIGTERM", handle);
}

async function startStdioTransport(createServer: () => McpServer, logger: Logger): Promise<void> {
	logger.info("Starting stdio transport");

	const handle = serveStdio(createServer, {
		onerror: (error) => logger.error({ error: getErrorMessage(error) }, "stdio error"),
	});
	onShutdown(async () => {
		await handle.close();
		return { forced: false };
	}, logger);

	logger.info("Connected via stdio");
	if (process.stdin.isTTY) {
		logger.warn("waiting for an MCP client on stdin; use --transport http for a network server");
	}
}

async function startHttpTransport(
	createServer: () => McpServer,
	config: Config,
	logger: Logger,
): Promise<void> {
	const httpServer = createHttpServer({
		createServer,
		host: config.mcpHost,
		port: config.mcpPort,
		logger,
		shutdownTimeoutMs: config.mcpShutdownTimeoutMs,
		allowedHosts: config.mcpAllowedHosts,
		allowedOrigins: config.mcpAllowedOrigins,
		authToken: config.mcpAuthToken,
		maxBodyBytes: config.mcpMaxBodyBytes,
	});

	// loadConfig already refused this unless MCP_ALLOW_UNAUTHENTICATED=true.
	if (isExposedWithoutAuth(config) && config.mcpAllowUnauthenticated) {
		logger.warn(
			"MCP_ALLOW_UNAUTHENTICATED=true: serving /mcp on a non-loopback address without authentication",
		);
	}
	await httpServer.start();
	onShutdown(() => httpServer.close(), logger);
}

main();
