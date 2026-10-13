/**
 * A fetch that never answers and rejects with the signal's reason when aborted.
 * `signalSeen` resolves with the request's AbortSignal once a request arrives;
 * `aborted` resolves when that signal fires.
 */
export function hangingFetch() {
	let seen: (signal: AbortSignal) => void = () => {};
	let fired: () => void = () => {};
	const signalSeen = new Promise<AbortSignal>((resolve) => {
		seen = resolve;
	});
	const aborted = new Promise<void>((resolve) => {
		fired = resolve;
	});
	const fetch = ((_url: unknown, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) return;
			seen(signal);
			signal.addEventListener("abort", () => {
				fired();
				reject(signal.reason);
			});
		})) as unknown as typeof globalThis.fetch;
	return { fetch, signalSeen, aborted };
}

/**
 * An endless response body of `chunkBytes`-sized chunks. `state.pulled` counts chunks produced and
 * `state.cancelled` flips when the consumer cancels the stream.
 */
export function streamingBody(chunkBytes = 512) {
	const state = { pulled: 0, cancelled: false };
	const chunk = new Uint8Array(chunkBytes).fill(97);
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			state.pulled++;
			controller.enqueue(chunk);
		},
		cancel() {
			state.cancelled = true;
		},
	});
	return { body, state };
}
