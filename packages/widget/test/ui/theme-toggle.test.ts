// @vitest-environment happy-dom
/**
 * K2 regression: theme toggle pins down all three behaviours flagged in
 * the audit:
 *   1. Three-state cycle: auto → light → dark → auto.
 *   2. Persistence: each transition writes to localStorage so a reload
 *      restores the user's choice.
 *   3. Restoration on connect: a pre-existing `geochatbot:theme=dark`
 *      entry should drive the widget into dark mode regardless of OS
 *      preference.
 *
 * The visual cascade fix (children inheriting via :host-context([theme="dark"]))
 * is verified end-to-end via Playwright in the audit-K2-*.png catalog;
 * those token rules are CSS-only and have no JS path to assert here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../src/element.js";
import type { GeoChatBotElement } from "../../src/element.js";

async function mount(): Promise<GeoChatBotElement> {
	const el = document.createElement("geo-chatbot") as GeoChatBotElement;
	document.body.appendChild(el);
	await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
	return el;
}

beforeEach(() => {
	try {
		localStorage.clear();
	} catch {
		// noop
	}
});

afterEach(() => {
	document.body.innerHTML = "";
});

describe("K2: theme toggle three-state cycle + persistence", () => {
	it("cycles auto → light → dark → auto and persists each step", async () => {
		const el = await mount();
		expect(el.theme).toBe("auto");

		const btn = el.shadowRoot?.querySelector(
			'button[aria-label="Toggle light or dark theme"]',
		) as HTMLButtonElement | null;
		expect(btn).toBeTruthy();
		if (!btn) return;

		btn.click();
		await el.updateComplete;
		expect(el.theme).toBe("light");
		expect(localStorage.getItem("geochatbot:theme")).toBe("light");

		btn.click();
		await el.updateComplete;
		expect(el.theme).toBe("dark");
		expect(localStorage.getItem("geochatbot:theme")).toBe("dark");

		btn.click();
		await el.updateComplete;
		expect(el.theme).toBe("auto");
		expect(localStorage.getItem("geochatbot:theme")).toBe("auto");
	});

	it("restores a persisted dark theme on connect", async () => {
		localStorage.setItem("geochatbot:theme", "dark");
		const el = await mount();
		expect(el.theme).toBe("dark");
		expect(el.getAttribute("theme")).toBe("dark");
	});

	it("ignores garbage values in localStorage", async () => {
		localStorage.setItem("geochatbot:theme", "rainbow-mode");
		const el = await mount();
		expect(el.theme).toBe("auto");
	});

	it("survives localStorage being unavailable", async () => {
		const original = Object.getOwnPropertyDescriptor(
			globalThis,
			"localStorage",
		);
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			get() {
				throw new Error("storage disabled");
			},
		});
		try {
			const el = await mount();
			expect(el.theme).toBe("auto");
			const btn = el.shadowRoot?.querySelector(
				'button[aria-label="Toggle light or dark theme"]',
			) as HTMLButtonElement | null;
			btn?.click();
			await el.updateComplete;
			// In-memory toggle still flips even when persistence fails.
			expect(el.theme).toBe("light");
		} finally {
			if (original) Object.defineProperty(globalThis, "localStorage", original);
		}
	});
});
