/** Base class for every error raised by the Zoekt client; `message` is safe to show to tool callers. */
export class ZoektError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
	}
}

// The three file errors below only exist so read_file can catch them by type.
export class ZoektFileNotFoundError extends ZoektError {}

export class ZoektAmbiguousFileError extends ZoektError {}

export class ZoektFileNotIndexedError extends ZoektError {}
