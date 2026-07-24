/**
 * Minimal `process` shim for bare-browser embedding.
 *
 * A handful of bundled dependencies reference Node's `process` global at
 * module-evaluation time (`process.version`, `process.hrtime`,
 * `process.browser`, …). Under Vite/Next those tools inject a `process`, but a
 * plain `<script type="module">` embed on an arbitrary page has none, so the
 * bundle throws "process is not defined" and the <geo-chatbot> element never
 * registers.
 *
 * This module has NO imports, so — as the FIRST import in `index.ts` — it is
 * evaluated before every other chunk (ES modules evaluate a file's imports in
 * order, depth-first, before the file's own body). It only fills in a `process`
 * when one is absent, so it never clobbers a real Node/bundler-provided global.
 */
const g = globalThis as { process?: unknown };

if (typeof g.process === "undefined") {
	g.process = {
		env: { NODE_ENV: "production" },
		browser: true,
		version: "",
		versions: {},
		platform: "browser",
		nextTick: (cb: (...a: unknown[]) => void, ...a: unknown[]) =>
			queueMicrotask(() => cb(...a)),
		hrtime: () => [0, 0],
		cwd: () => "/",
	};
}

export {};
