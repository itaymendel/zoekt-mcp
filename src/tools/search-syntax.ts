import { z } from "zod";
import querySyntax from "../zoekt/query-syntax.md" with { type: "text" };
import type { Tool } from "./tool.js";

interface Section {
	slug: string;
	heading: string;
	body: string;
}

/** The upstream guide split on its `## ` headings; the intro before the first one is dropped. */
const SECTIONS: Section[] = querySyntax
	.split(/^## /m)
	.slice(1)
	.map((chunk) => {
		const [heading = "", ...rest] = chunk.split("\n");
		const body = rest
			.join("\n")
			.replace(/\n---\s*$/, "")
			.trim();
		return {
			slug: heading.trim().toLowerCase().replace(/\W+/g, "-"),
			heading: heading.trim(),
			body,
		};
	});

const inputSchema = z.object({
	topic: z.string().optional().describe("Section to read; omit to list the sections"),
});

const description =
	"Read the Zoekt query-language guide that `search` uses (fields, operators, grouping, case, result types, examples). Call without a topic to list the sections, then again with one. Only needed when the syntax in the `search` description is not enough.";

export const searchSyntaxTool: Tool<typeof inputSchema> = {
	name: "search_syntax",
	title: "Zoekt query syntax",
	description,
	inputSchema,
	async execute(_client, { topic }) {
		const section = SECTIONS.find((s) => s.slug === topic);
		if (section) return `## ${section.heading}\n\n${section.body}`;
		const index = SECTIONS.map((s) => `- ${s.slug}: ${s.heading}`).join("\n");
		if (topic === undefined)
			return `Zoekt query-language guide. Call again with one of these topics:\n${index}`;
		throw new Error(`Unknown topic "${topic}". Topics:\n${index}`);
	},
};
