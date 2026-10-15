/** Base class for every error raised by the Zoekt client; `message` is safe to show to tool callers. */
export class ZoektError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
	}
}

// The file errors below are typed so callers can tell them apart.
export class ZoektFileNotFoundError extends ZoektError {}

export class ZoektAmbiguousFileError extends ZoektError {}

export class ZoektFileNotIndexedError extends ZoektError {}

/**
 * Zoekt gives no out-of-band signal for files it skipped (binary, too large): it indexes a stub
 * that is exactly `NOT-INDEXED: <reason>`. Heuristic: a real file holding only that line is taken
 * as the stub too. Returns the reason, or undefined for anything else.
 */
export function notIndexedReason(text: string): string | undefined {
	return /^NOT-INDEXED: (.+)$/.exec(text.trim())?.[1];
}
