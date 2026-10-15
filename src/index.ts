#!/usr/bin/env node
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import pkg from "../package.json";
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { createMcpServer } from "./server.js";
import { getErrorMessage, redactUrl } from "./utils.js";
import { ZoektClient } from "./zoekt/client.js";

const REQUEST_TIMEOUT_MS = 30_000;

function printHelp(): void {
	console.log(`zoekt-mcp - MCP server for Zoekt code search

Usage: zoekt-mcp [options]

Options:
  --url <url>          Zoekt webserver URL (required, or set ZOEKT_URL)
  --transport <mode>   Transport: "stdio" (default) or "http"
  --port <number>      HTTP port (default: 3000)
  -h, --help           Show this help
  -v, --version        Show the version

Every option also has an environment variable (--url is ZOEKT_URL, and so on).
Environment-only settings: MCP_HOST (HTTP bind address, default 127.0.0.1), LOG_LEVEL (debug,
info, warn or error; default info), MCP_AUTH_TOKEN and MCP_ALLOWED_HOSTS.
Exit code 2 means a usage or configuration error.

Example: zoekt-mcp --url http://localhost:6070
Docs:    https://github.com/itaymendel/zoekt-mcp#readme`);
}

function parseCliArgs(): Record<string, string | undefined> {
	const { values } = parseArgs({
		options: {
			url: { type: "string" },
			transport: { type: "string" },
			port: { type: "string" },
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
	};
}

async function main(): Promise<void> {
	let logger = createLogger("info");

	try {
		const cliArgs = parseCliArgs();
		let config: ReturnType<typeof loadConfig>;
		try {
			config = loadConfig(cliArgs);
		} catch (error) {
			console.error((error as Error).message);
			process.exit(2);
		}
		logger = createLogger(config.logLevel);

		logger.info(
			{ transport: config.mcpTransport, zoektUrl: redactUrl(config.zoektUrl) },
			"Starting zoekt-mcp",
		);

		// Built once; the factory below runs per request (HTTP) or per connection (stdio).
		const client = new ZoektClient({
			baseUrl: config.zoektUrl,
			timeoutMs: REQUEST_TIMEOUT_MS,
			logger,
		});
		const createServer = () => createMcpServer({ client, logger });

		if (config.mcpTransport === "stdio") {
			const handle = serveStdio(createServer, {
				onerror: (error) => logger.error({ error: getErrorMessage(error) }, "stdio error"),
			});
			onShutdown(() => handle.close(), logger);
			logger.info("Connected via stdio");
		} else {
			const httpServer = createHttpServer({
				createServer,
				host: config.mcpHost,
				port: config.mcpPort,
				logger,
				allowedHosts: config.mcpAllowedHosts,
				authToken: config.mcpAuthToken,
			});

			await httpServer.start();
			onShutdown(() => httpServer.close(), logger);
		}
	} catch (error) {
		if (String((error as NodeJS.ErrnoException).code).startsWith("ERR_PARSE_ARGS")) {
			console.error(`Error: ${(error as Error).message}`);
			console.error('Run "zoekt-mcp --help" for usage information.');
			process.exit(2);
		}
		logger.error({ error: getErrorMessage(error) }, "Fatal error");
		process.exit(1);
	}
}

/** One handler for both signals: exit 0 once closed (even if stuck connections were dropped), 1 if closing fails; a second signal exits 1. */
function onShutdown(close: () => Promise<void>, logger: Logger): void {
	let shuttingDown = false;
	const handle = (signal: string) => {
		if (shuttingDown) {
			logger.warn(`Received ${signal} again, exiting immediately`);
			process.exit(1);
		}
		shuttingDown = true;
		logger.info(`Received ${signal}, shutting down`);
		close().then(
			() => process.exit(0),
			(error) => {
				logger.error({ error: getErrorMessage(error) }, "Shutdown failed");
				process.exit(1);
			},
		);
	};
	process.on("SIGINT", handle);
	process.on("SIGTERM", handle);
}

main();
