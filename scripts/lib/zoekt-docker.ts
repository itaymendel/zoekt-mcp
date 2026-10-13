import { execFileSync } from "node:child_process";
import type { FixtureRepo } from "../../tests/helpers/fixture-repo.js";

/**
 * Pinned upstream Zoekt image (revision 27517a30ae6d). Upstream publishes no tags, so the
 * digest is the pin. To bump: pick a new digest from ghcr.io/sourcegraph/zoekt, update this
 * constant, run `bun run fixtures:capture` and review the diff.
 */
export const ZOEKT_IMAGE =
	"ghcr.io/sourcegraph/zoekt@sha256:403b51206099f04d53bb7fcdfed0c81a20f263722f287cb7830376fd6a7c3923";

const PLATFORM = "linux/amd64";

function docker(args: string[]): string {
	return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Runs `zoekt-git-index` for every repository in one container. `reposDir` holds the git
 * repos, `indexDir` receives the shards.
 */
export function indexRepos(
	reposDir: string,
	indexDir: string,
	repos: readonly Pick<FixtureRepo, "dir" | "indexBranches" | "disableCtags">[],
): void {
	const env = {
		HOME: "/tmp",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "safe.directory",
		GIT_CONFIG_VALUE_0: "*",
	};
	const script = repos
		.map((repo) => {
			const ctags = repo.disableCtags ? " -disable_ctags" : "";
			return `zoekt-git-index -index /index -branches ${repo.indexBranches}${ctags} /repos/${repo.dir}`;
		})
		.join(" && ");
	docker([
		"run",
		"--rm",
		"--platform",
		PLATFORM,
		"--user",
		`${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
		...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
		"-v",
		`${reposDir}:/repos:ro`,
		"-v",
		`${indexDir}:/index`,
		"--entrypoint",
		"sh",
		ZOEKT_IMAGE,
		"-c",
		script,
	]);
}

export interface RunningWebserver {
	containerId: string;
	baseUrl: string;
}

/** Starts the image's default CMD (zoekt-webserver) on a random localhost port and waits for /readyz. */
export async function startWebserver(indexDir: string): Promise<RunningWebserver> {
	const containerId = docker([
		"run",
		"-d",
		"--rm",
		"--platform",
		PLATFORM,
		"-p",
		"127.0.0.1::6070",
		"-v",
		`${indexDir}:/data/index:ro`,
		ZOEKT_IMAGE,
	]).trim();

	try {
		const port = docker([
			"inspect",
			"-f",
			'{{(index (index .NetworkSettings.Ports "6070/tcp") 0).HostPort}}',
			containerId,
		]).trim();
		const baseUrl = `http://127.0.0.1:${port}`;
		await waitReady(baseUrl, 60_000);
		return { containerId, baseUrl };
	} catch (error) {
		stop(containerId);
		throw error;
	}
}

async function waitReady(baseUrl: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		try {
			if ((await fetch(`${baseUrl}/readyz`)).ok) return;
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`zoekt-webserver did not become ready in ${timeoutMs / 1000}s`);
}

export function stop(containerId: string): void {
	try {
		docker(["rm", "-f", containerId]);
	} catch {
		// already gone
	}
}
