import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Diagnostic — verify CORS on api.ai.it.ufl.edu allows browser fetch from
 * localhost:5174. If this fails the whole UF Navigator e2e suite can't run
 * from the browser; we'd need a dev-only Vite proxy.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
function loadEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		for (const l of readFileSync(
			resolve(REPO_ROOT, ".env.local"),
			"utf8",
		).split(/\r?\n/)) {
			const t = l.trim();
			if (!t || t.startsWith("#")) continue;
			const eq = t.indexOf("=");
			if (eq < 0) continue;
			out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
		}
	} catch {}
	return out;
}
const E = loadEnv();
const KEY = process.env.NAVIGATOR_API_KEY ?? E.NAVIGATOR_API_KEY ?? "";

test("CORS: browser can fetch /v1/models from UF Navigator", async ({
	page,
}) => {
	test.skip(!KEY, "NAVIGATOR_API_KEY missing");
	const consoleErrors: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	await page.goto("/");
	const res = await page.evaluate(async (key) => {
		try {
			const r = await fetch("https://api.ai.it.ufl.edu/v1/models", {
				headers: { Authorization: `Bearer ${key}` },
			});
			const j = await r.json();
			return {
				ok: r.ok,
				status: r.status,
				modelCount: Array.isArray((j as { data?: unknown[] }).data)
					? (j as { data: unknown[] }).data.length
					: 0,
				err: null as string | null,
			};
		} catch (e) {
			return { ok: false, status: 0, modelCount: 0, err: String(e) };
		}
	}, KEY);
	console.log("CORS probe:", JSON.stringify(res, null, 2));
	console.log("Console errors:", consoleErrors);
	expect(res.ok, `fetch failed: ${res.err}`).toBe(true);
	expect(res.modelCount).toBeGreaterThan(0);
});
