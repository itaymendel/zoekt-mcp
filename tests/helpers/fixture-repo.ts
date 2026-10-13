/**
 * Constants describing the synthetic repositories that the Zoekt fixtures are captured from.
 * Source trees live in tests/fixtures/zoekt/repos/<dir> and hold the contents of the default
 * branch (`main`); `overlays` describe how other branches differ from it.
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/** Single base location for everything under tests/fixtures/zoekt. */
export const FIXTURES_URL = new URL("../fixtures/zoekt/", import.meta.url);
export const CASES_URL = new URL("cases/", FIXTURES_URL);
export const MANIFEST_URL = new URL("MANIFEST.json", FIXTURES_URL);
export const REPO_SOURCES_DIR = fileURLToPath(new URL("repos/", FIXTURES_URL));
export const CASES_DIR = fileURLToPath(CASES_URL);
export const MANIFEST_PATH = fileURLToPath(MANIFEST_URL);

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export const ALPHA_REPO = "example.test/alpha";
export const BETA_REPO = "example.test/beta";
export const DELTA_REPO = "example.test/delta";

export interface FixtureRepo {
	/** Directory name under REPO_SOURCES_DIR. */
	dir: string;
	/** Repository name as reported by Zoekt (`zoekt.name` git config). */
	name: string;
	/** Value for `zoekt-git-index -branches`. */
	indexBranches: string;
	/** Pass `-disable_ctags` to the indexer. */
	disableCtags: boolean;
	/** Extra branches created from `main`: path -> new file content. */
	overlays: Record<string, Record<string, string>>;
}

export const FIXTURE_REPOS: readonly FixtureRepo[] = [
	{
		dir: "alpha",
		name: ALPHA_REPO,
		indexBranches: "main,main-old,feature",
		disableCtags: false,
		overlays: {
			"main-old": { Makefile: "build:\n\techo old version\n" },
			feature: { "src/feature.ts": "export const feature = true;\n" },
		},
	},
	{
		dir: "beta",
		name: BETA_REPO,
		indexBranches: "HEAD",
		disableCtags: true,
		overlays: {},
	},
	{
		dir: "delta",
		name: DELTA_REPO,
		indexBranches: "HEAD",
		disableCtags: true,
		overlays: {},
	},
];

/** Fixed git identity/dates so that the synthetic repositories (and indexes) are reproducible. */
export const GIT_FIXED_ENV: Record<string, string> = {
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.test",
	GIT_AUTHOR_DATE: "2020-01-01T00:00:00+0000",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.test",
	GIT_COMMITTER_DATE: "2020-01-01T00:00:00+0000",
};
