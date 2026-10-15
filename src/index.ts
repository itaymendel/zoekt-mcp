#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { createMcpServer } from "./server.js";
import { getErrorMessage, redactUrl } from "./utils.js";
import { ZoektClient } from "./zoekt/client.js";

const REQUEST_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
	let logger = createLogger("info");

	try {
		const config = loadConfig();
		logger = createLogger(config.logLevel);

		logger.info(
			{ transport: config.transport, zoektUrl: redactUrl(config.zoektUrl) },
			"Starting zoekt-mcp",
		);

		const client = new ZoektClient({
			baseUrl: config.zoektUrl,
			timeoutMs: REQUEST_TIMEOUT_MS,
			logger,
		});
		const createServer = () => createMcpServer({ client, logger });

		if (config.transport === "stdio") {
			const handle = serveStdio(createServer, {
				onerror: (error) => logger.error({ error: getErrorMessage(error) }, "stdio error"),
			});
			onShutdown(() => handle.close(), logger);
			logger.info("Connected via stdio");
		} else {
			const http = await startHttpServer({
				createServer,
				host: config.host,
				port: config.port,
				logger,
				authToken: config.authToken,
			});
			onShutdown(() => http.close(), logger);
		}
	} catch (error) {
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
