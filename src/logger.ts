import pino from "pino";
import type { LogLevel } from "./config.js";

export type Logger = pino.Logger;

/** Never let credentials reach a log line, even if a request object is logged later. */
const LOG_REDACT = {
	paths: ["req.headers.authorization", "headers.authorization", "authorization", "token"],
	censor: "[redacted]",
};

export function createLogger(
	minLevel: LogLevel,
	destination: pino.DestinationStream = pino.destination({ dest: 2, sync: true }),
): Logger {
	return pino({ level: minLevel, redact: LOG_REDACT }, destination);
}
