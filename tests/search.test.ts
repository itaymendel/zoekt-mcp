import { describe, expect, test } from "bun:test";
import { formatSearchResultsAsText } from "../src/utils.js";
import { SearchResultSchema } from "../src/zoekt/types.js";

const mockSearchResponse = {
	result: SearchResultSchema.parse({
		FileMatches: [
			{
				FileName: "src/main.ts",
				Repo: "github.com/example/repo",
				Branches: ["main"],
				Language: "TypeScript",
				Matches: [
					{
						URL: "print?f=src%2Fmain.ts&q=handleRequest&r=github.com/example/repo#l15",
						FileName: "src/main.ts",
						LineNum: 15,
						Fragments: [
							{
								Pre: "function ",
								Match: "handleRequest",
								Post: "(req: Request) {",
							},
						],
					},
				],
			},
		],
		RepoURLs: {
			"github.com/example/repo": "https://github.com/example/repo",
		},
		Stats: {
			Duration: 15000,
			FileCount: 1,
			MatchCount: 1,
		},
	}),
};

describe("formatSearchResultsAsText", () => {
	test("should format results as readable text", () => {
		const text = formatSearchResultsAsText(mockSearchResponse);

		expect(text).toContain("github.com/example/repo/src/main.ts");
		expect(text).toContain("TypeScript");
		expect(text).toContain("15:");
		expect(text).toContain("handleRequest");
	});

	test("should handle no matches", () => {
		const text = formatSearchResultsAsText({ result: SearchResultSchema.parse({}) });

		expect(text).toBe("No matches found.");
	});

	test("should handle empty files array", () => {
		const text = formatSearchResultsAsText({
			result: SearchResultSchema.parse({ FileMatches: [] }),
		});

		expect(text).toBe("No matches found.");
	});
});
