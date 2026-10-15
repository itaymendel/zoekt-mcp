import { fileURLToPath } from "node:url";

/** Captured Zoekt responses live in tests/fixtures/zoekt/cases. */
export const CASES_URL = new URL("../fixtures/zoekt/cases/", import.meta.url);
export const CASES_DIR = fileURLToPath(CASES_URL);

export const ALPHA_REPO = "example.test/alpha";
export const BETA_REPO = "example.test/beta";
export const DELTA_REPO = "example.test/delta";
