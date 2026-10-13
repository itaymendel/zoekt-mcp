/** A single row is clipped to this many characters (ellipses included). */
export const MAX_LINE_CHARS = 240;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

export interface ClipOptions {
	/** `[start, end)` span to keep in view (e.g. the first match); defaults to the start of the text. */
	focus?: [number, number];
	/** Maximum length of the result, ellipses included. */
	max?: number;
}

/** `text` cut to `max` characters around `focus`, never splitting a surrogate pair. */
export function clipLine(text: string, { focus, max = MAX_LINE_CHARS }: ClipOptions = {}): string {
	if (text.length <= max) return text;
	const body = max - 2; // room for a leading and a trailing ellipsis
	const [from, to] = focus ?? [0, 0];
	const spanLen = Math.min(Math.max(to - from, 0), body);
	let start = Math.max(0, from - Math.floor((body - spanLen) / 2));
	let end = start + body;
	if (end > text.length) {
		end = text.length;
		start = Math.max(0, end - body);
	}
	if (start > 0 && isLow(text.charCodeAt(start))) start++;
	if (end < text.length && isHigh(text.charCodeAt(end - 1))) end--;
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** `s` cut to `max` characters (no half surrogate pair) followed by a marker line, when it is longer. */
export function hardClip(s: string, max: number, marker = "[output truncated]"): string {
	if (s.length <= max) return s;
	const end = isHigh(s.charCodeAt(max - 1)) ? max - 1 : max;
	return `${s.slice(0, end)}\n${marker}`;
}
