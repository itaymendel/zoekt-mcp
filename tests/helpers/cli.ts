const ENTRY = "src/index.ts";

export function spawn(args: string[], env: Record<string, string> = {}) {
	return Bun.spawn(["bun", ENTRY, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		// Start from a clean slate so the host's ZOEKT_URL/MCP_* never leak into a test.
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
	});
}

export async function run(args: string[], env: Record<string, string> = {}) {
	const proc = spawn(args, env);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}
