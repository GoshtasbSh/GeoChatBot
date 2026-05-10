import { defineConfig, devices } from "@playwright/test";

/**
 * Note: the demo workspace's vite.config.ts pins port 5174. The task spec
 * suggested 5173, but we follow the actual demo port to avoid touching demo
 * (out of scope for this agent).
 */
const PORT = 5174;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: "./tests",
	timeout: 60_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	reporter: [["list"]],
	use: {
		baseURL: BASE_URL,
		trace: "on-first-retry",
		headless: true,
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command: "npm run dev --workspace=@geochatbot/demo",
		cwd: "..",
		url: BASE_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
