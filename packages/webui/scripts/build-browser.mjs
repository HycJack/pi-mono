/**
 * Bundle the browser client into a single static/app.js file.
 *
 * Run from the package root: node scripts/build-browser.mjs
 */

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const staticDir = join(root, "static");

await mkdir(staticDir, { recursive: true });

const result = await build({
	entryPoints: [join(root, "src/client/index.ts")],
	bundle: true,
	outfile: join(staticDir, "app.js"),
	format: "esm",
	target: "es2022",
	sourcemap: true,
	logLevel: "info",
	conditions: ["source"],
});

if (result.errors.length > 0) {
	console.error(result.errors);
	process.exit(1);
}
console.log(`bundled ${join("static", "app.js")}`);