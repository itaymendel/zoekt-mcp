/** Base class for every error raised by the Zoekt client; `message` is safe to show to tool callers. */
export class ZoektError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
	}
}

/** Non-2xx answer from Zoekt (anything but a rejected /search query). */
export class ZoektHttpError extends ZoektError {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** Zoekt answered 418 on /search: it rejected the query text (parse error and similar). */
export class ZoektQueryError extends ZoektError {}

/** A 200 answer that is not the JSON shape we expect, or the wrong branch of the response union. */
export class ZoektProtocolError extends ZoektError {}

export class ZoektFileNotFoundError extends ZoektError {
	constructor(
		readonly repo: string,
		readonly path: string,
		readonly branch?: string,
	) {
		super(`File not found in index: ${repo}:${path}${branch ? ` (branch ${branch})` : ""}`);
	}
}

export class ZoektAmbiguousFileError extends ZoektError {
	constructor(
		readonly repo: string,
		readonly path: string,
		readonly versionCount: number,
	) {
		super(
			`Multiple indexed versions of ${repo}:${path} exist (content differs between branches). Pass a branch.`,
		);
	}
}

export class ZoektFileNotIndexedError extends ZoektError {
	constructor(
		readonly repo: string,
		readonly path: string,
		readonly reason: "binary" | "too-large" | "other",
		readonly detail: string,
	) {
		super(`File is not indexed by Zoekt (${detail}): ${repo}:${path}`);
	}
}
