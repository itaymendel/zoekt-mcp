import pino from "pino";
import type { LogLevel } from "./config.js";

export type Logger = pino.Logger;

export function createLogger(minLevel: LogLevel, context?: Record<string, unknown>): Logger {
	const logger = pino({ level: minLevel }, pino.destination({ dest: 2, sync: true }));

	return context ? logger.child(context) : logger;
}
