import { describe, expect, it } from "vitest";

describe("GeoChatBot widget smoke", () => {
	it(
		"exports a defineGeoChatBot function and the GeoChatBotElement class",
		async () => {
			// Stub browser-only globals before importing the entry, since this test
			// runs under node and the entry imports modules that touch DOM types.
			const g = globalThis as unknown as {
				HTMLElement?: typeof HTMLElement;
				customElements?: {
					define: (...a: unknown[]) => void;
					get: (n: string) => unknown;
				};
			};
			if (typeof g.HTMLElement === "undefined") {
				g.HTMLElement = class {} as unknown as typeof HTMLElement;
			}
			if (typeof g.customElements === "undefined") {
				g.customElements = {
					define: () => undefined,
					get: () => undefined,
				};
			}
			const mod = await import("../src/index.js");
			expect(typeof mod.defineGeoChatBot).toBe("function");
			expect(typeof mod.GeoChatBotElement).toBe("function");
			expect(typeof mod.createEcho).toBe("function");
			expect(() => mod.defineGeoChatBot()).not.toThrow();
		},
		{
			// Full entry registers <geo-chatbot> and pulls the widget graph; cold
			// CI can exceed Vitest's default 5s.
			timeout: 60_000,
		},
	);
});
