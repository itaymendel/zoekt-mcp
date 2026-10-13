#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import pkg from "../package.json";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { createServerFactory } from "./server.js";
import { getErrorMessage } from "./utils.js";
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
  --transport <mode>   Transport mode: "http" or "stdio" (default: auto-detect)
  --port <number>      HTTP server port (default: 3000)
  --host <address>     HTTP server host (default: 0.0.0.0)
  --log-level <level>  Log level: debug, info, warn, error (default: info)
  --timeout <ms>       Zoekt request timeout in ms (default: 30000)
  --help, -h           Show this help message
  --version, -v        Show version

EXAMPLES:
  zoekt-mcp --url http://localhost:6070
  zoekt-mcp --url http://localhost:6070 --transport stdio
  zoekt-mcp --url http://localhost:6070 --port 8080 --log-level debug

ENVIRONMENT VARIABLES:
  ZOEKT_URL          Zoekt webserver URL
  MCP_TRANSPORT      Transport mode (http or stdio)
  MCP_PORT           HTTP server port
  MCP_HOST           HTTP server host
  LOG_LEVEL          Log level
  ZOEKT_TIMEOUT_MS   Request timeout in milliseconds
`);
}

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
		if (error instanceof Error && error.message.includes("Unknown option")) {
			console.error(`Error: ${error.message}`);
			console.error('Run "zoekt-mcp --help" for usage information.');
			process.exit(1);
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
			{ transport: config.mcpTransport, zoektUrl: config.zoektUrl },
			"Starting zoekt-mcp",
		);

		// Built once; the factory below runs per request (HTTP) or per connection (stdio).
		const client = new ZoektClient({
			baseUrl: config.zoektUrl,
			timeoutMs: config.zoektTimeoutMs,
			logger,
		});
		const createServer = createServerFactory({ client, logger });

		if (config.mcpTransport === "stdio") {
			await startStdioTransport(createServer, logger);
		} else {
			await startHttpTransport(createServer, config, logger);
		}
	} catch (error) {
		logger.error({ error: getErrorMessage(error) }, "Fatal error");
		process.exit(1);
	}
}

function onShutdown(close: () => Promise<void>, logger: Logger): void {
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			logger.info(`Received ${signal}, shutting down`);
			close()
				.catch((error) => logger.error({ error: getErrorMessage(error) }, "Shutdown failed"))
				.finally(() => process.exit(0));
		});
	}
}

async function startStdioTransport(createServer: () => McpServer, logger: Logger): Promise<void> {
	logger.info("Starting stdio transport");

	const handle = serveStdio(createServer, {
		onerror: (error) => logger.error({ error: getErrorMessage(error) }, "stdio error"),
	});
	onShutdown(() => handle.close(), logger);

	logger.info("Connected via stdio");
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
	});

	await httpServer.start();
	onShutdown(() => httpServer.close(), logger);
}

main();
