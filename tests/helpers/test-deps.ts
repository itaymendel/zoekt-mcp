import pino from "pino";
import type { ServerDeps } from "../../src/server.js";
import { ZoektClient } from "../../src/zoekt/client.js";

/** Server dependencies with a silent logger; `fetch` defaults to the global at call time. */
export function testDeps(
	fetch?: typeof globalThis.fetch,
	{
		baseUrl = "http://zoekt.test",
		timeoutMs = 5000,
	}: { baseUrl?: string; timeoutMs?: number } = {},
): ServerDeps {
	const logger = pino({ level: "silent" });
	return {
		client: new ZoektClient({ baseUrl, timeoutMs, logger, fetch }),
		logger,
		cacheScope: "public",
	};
}
