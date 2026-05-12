// @vitest-environment happy-dom
/**
 * §U storage quotas — graceful degradation when localStorage / IDB are
 * over quota.
 *
 * Audit invariants:
 *   U1 IDB-near-full: memory store writes don't crash the widget;
 *      worst case the save is dropped, surfaced as a warning.
 *   U2 localStorage-full: settings save handles QuotaExceeded; the
 *      in-memory state remains correct (the user can still operate
 *      this session; reload won't restore).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type GeoChatBotElement, defineGeoChatBot } from "../src/index";

beforeEach(() => {
	defineGeoChatBot();
	try {
		localStorage.clear();
	} catch {
		/* noop */
	}
});

function mount(): GeoChatBotElement {
	const el = document.createElement("geo-chatbot") as GeoChatBotElement;
	document.body.appendChild(el);
	return el;
}

describe("§U2 localStorage QuotaExceeded does not break settings save", () => {
	it("settings dispatch updates in-memory state even when localStorage.setItem throws", async () => {
		const el = mount();
		await el.updateComplete;

		// Force every localStorage.setItem to throw a QuotaExceeded-shaped
		// error. The element wraps writes in try/catch; the in-memory
		// reactive properties below must still update.
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = () => {
			const err = new Error("QuotaExceededError");
			(err as Error & { name: string }).name = "QuotaExceededError";
			throw err;
		};

		try {
			// _onSaveSettings is wired as a `@gcb:settings` listener on the
			// inner settings-drawer via Lit's template binding. For a
			// stand-alone widget test (no drawer rendered) we invoke it
			// directly with the same payload shape.
			const handler = (el as unknown as { _onSaveSettings: (e: Event) => void })
				._onSaveSettings;
			handler(
				new CustomEvent("gcb:settings", {
					detail: {
						provider: "groq",
						apiKey: "test",
						model: "llama-3.3-70b-versatile",
						dangerouslyAllowBrowser: true,
						agenticMode: "agentic",
						retrievalMode: "off",
						memoryEnabled: false,
					},
				}),
			);
			await el.updateComplete;

			// In-memory state took the update despite the storage failures.
			expect(el.agenticMode).toBe("agentic");
			expect((el as unknown as { _llmProvider: string })._llmProvider).toBe(
				"groq",
			);
			expect((el as unknown as { _model: string })._model).toBe(
				"llama-3.3-70b-versatile",
			);
		} finally {
			Storage.prototype.setItem = original;
		}
	});

	it("theme toggle survives a Quota error during persistence", async () => {
		const el = mount();
		await el.updateComplete;

		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = () => {
			const err = new Error("QuotaExceededError");
			(err as Error & { name: string }).name = "QuotaExceededError";
			throw err;
		};
		try {
			const btn = el.shadowRoot?.querySelector(
				'button[aria-label="Toggle light or dark theme"]',
			) as HTMLButtonElement | null;
			btn?.click();
			await el.updateComplete;
			// In-memory theme reactive property still flipped.
			expect(el.theme).toBe("light");
		} finally {
			Storage.prototype.setItem = original;
		}
	});
});
