// Build the standalone widget bundle and copy it into the site's public dir
// so it is served at `/widget/geochatbot.js` from the deployment. This makes
// the README/docs embed snippet load a URL that actually works, without
// publishing to npm. Runs as part of the site build (local + Vercel).
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // packages/site/scripts
const widgetDist = join(here, "..", "..", "widget", "dist");
const outDir = join(here, "..", "public", "widget");

console.log("[bundle-widget] building @geochatbot/widget…");
execSync("pnpm --filter @geochatbot/widget build", {
	stdio: "inherit",
	cwd: join(here, "..", "..", ".."),
});

if (!existsSync(join(widgetDist, "geochatbot.js"))) {
	throw new Error(`[bundle-widget] widget build produced no dist at ${widgetDist}`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Copy only what the browser needs: the ES entry + its lazily-imported JS
// chunks (preserving subdirectories). Skip sourcemaps, type declarations,
// the UMD build, and bundled data files.
const skip = (name) =>
	name.endsWith(".map") ||
	name.endsWith(".d.ts") ||
	name.endsWith(".umd.cjs") ||
	name.endsWith(".csv");

let count = 0;
function copyTree(srcDir, dstDir) {
	for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
		const src = join(srcDir, entry.name);
		const dst = join(dstDir, entry.name);
		if (entry.isDirectory()) {
			copyTree(src, dst);
		} else if ((entry.name.endsWith(".js") || entry.name.endsWith(".wasm")) && !skip(entry.name)) {
			mkdirSync(dirname(dst), { recursive: true });
			cpSync(src, dst);
			count++;
		}
	}
}
copyTree(widgetDist, outDir);
console.log(`[bundle-widget] copied ${count} files → public/widget/`);
