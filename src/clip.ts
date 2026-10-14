/** A single row is clipped to this many characters (ellipses included). */
export const MAX_LINE_CHARS = 240;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * `text` cut to `max` characters (ellipses included) around `focus`, a `[start, end)` span to keep
 * in view (default: the start of the text), never splitting a surrogate pair.
 */
export function clipLine(
	text: string,
	{ focus, max = MAX_LINE_CHARS }: { focus?: [number, number]; max?: number } = {},
): string {
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

/** `max`, or one less when that would split a surrogate pair of `s`; cut `s` there. */
export const cutEnd = (s: string, max: number) => (isHigh(s.charCodeAt(max - 1)) ? max - 1 : max);

/** `s` without one trailing `\n` and then one trailing `\r`. */
export const stripEol = (s: string) => {
	const noLf = s.endsWith("\n") ? s.slice(0, -1) : s;
	return noLf.endsWith("\r") ? noLf.slice(0, -1) : noLf;
};

/** `text` split on `\n`; the empty element after a final newline is dropped (`""` has no lines). */
export function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}
