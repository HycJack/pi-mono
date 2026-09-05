/**
 * Runnable CLI entry for the webui server.
 *
 * Usage:
 *   node dist/server/main.js --port 3000 --hostname 0.0.0.0 \
 *     --create-user --username admin --password secret
 *
 * Env vars: PI_WEBUI_PORT, PI_WEBUI_HOST, PI_WEBUI_DATA (default ~/.pi/webui).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startWebui } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const defaultStaticDir = join(here, "..", "..", "static");

function parseArgs(args: readonly string[]): Record<string, string | undefined> {
	const result: Record<string, string | undefined> = {};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		const next = args[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			result[key] = next;
			i += 1;
		} else {
			result[key] = "true";
		}
	}
	return result;
}

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? process.env.PI_WEBUI_PORT ?? "3000");
const hostname = args.hostname ?? process.env.PI_WEBUI_HOST ?? "0.0.0.0";
const dataRoot = args.data ?? process.env.PI_WEBUI_DATA;

const running = await startWebui({
	accountsPath: dataRoot !== undefined ? join(dataRoot, "accounts.json") : undefined,
	sessionsRoot: dataRoot !== undefined ? join(dataRoot, "sessions") : undefined,
	staticDir: args.static ?? defaultStaticDir,
	port,
	hostname,
	username: args.username,
	password: args.password,
	createUser: args["create-user"] === "true",
});

console.log(`webui listening on http://${hostname}:${running.server.port}`);
console.log(`server id: ${running.serverId}`);

const stop = async (): Promise<void> => {
	await running.close();
	process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
