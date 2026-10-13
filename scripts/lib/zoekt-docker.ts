import { execFileSync } from "node:child_process";

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

export interface IndexRepoSpec {
	/** Path of the git repository inside `reposDir`. */
	dir: string;
	branches: string;
	disableCtags: boolean;
}

/** Runs `zoekt-git-index` for each repository. `reposDir` holds git repos, `indexDir` receives shards. */
export function indexRepos(reposDir: string, indexDir: string, specs: IndexRepoSpec[]): void {
	const uid = process.getuid?.() ?? 1000;
	const gid = process.getgid?.() ?? 1000;
	for (const spec of specs) {
		const args = [
			"run",
			"--rm",
			"--platform",
			PLATFORM,
			"--user",
			`${uid}:${gid}`,
			"-e",
			"HOME=/tmp",
			"-e",
			"GIT_CONFIG_COUNT=1",
			"-e",
			"GIT_CONFIG_KEY_0=safe.directory",
			"-e",
			"GIT_CONFIG_VALUE_0=*",
			"-v",
			`${reposDir}:/repos:ro`,
			"-v",
			`${indexDir}:/index`,
			"--entrypoint",
			"zoekt-git-index",
			ZOEKT_IMAGE,
			"-index",
			"/index",
			"-branches",
			spec.branches,
		];
		if (spec.disableCtags) args.push("-disable_ctags");
		args.push(`/repos/${spec.dir}`);
		docker(args);
	}
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
		const port = docker(["port", containerId, "6070/tcp"]).trim().split("\n")[0].split(":").pop();
		const baseUrl = `http://127.0.0.1:${port}`;

		const deadline = Date.now() + 60_000;
		for (;;) {
			try {
				const res = await fetch(`${baseUrl}/readyz`);
				if (res.ok) return { containerId, baseUrl };
			} catch {
				// not up yet
			}
			if (Date.now() > deadline) throw new Error("zoekt-webserver did not become ready in 60s");
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	} catch (error) {
		stop(containerId);
		throw error;
	}
}

export function stop(containerId: string): void {
	try {
		docker(["rm", "-f", containerId]);
	} catch {
		// already gone
	}
}
