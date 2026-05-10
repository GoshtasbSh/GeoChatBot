// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import "../../src/ui/modal.js";

interface ModalEl extends HTMLElement {
	open: boolean;
	updateComplete: Promise<unknown>;
}

function mount(open = false): ModalEl {
	const el = document.createElement("gcb-modal") as never as ModalEl;
	el.open = open;
	el.innerHTML = '<button class="card-btn">inside</button>';
	document.body.appendChild(el);
	return el;
}

describe("<gcb-modal>", () => {
	it("renders nothing visible when open=false", async () => {
		const el = mount(false);
		await el.updateComplete;
		expect(el.shadowRoot?.querySelector(".scrim")).toBeNull();
	});

	it("renders scrim + card when open=true", async () => {
		const el = mount(true);
		await el.updateComplete;
		expect(el.shadowRoot?.querySelector(".scrim")).not.toBeNull();
		expect(el.shadowRoot?.querySelector(".card")).not.toBeNull();
	});

	it("emits gcb:modal-close on Escape", async () => {
		const el = mount(true);
		await el.updateComplete;
		const spy = vi.fn();
		el.addEventListener("gcb:modal-close", spy);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("emits gcb:modal-close on scrim click", async () => {
		const el = mount(true);
		await el.updateComplete;
		const spy = vi.fn();
		el.addEventListener("gcb:modal-close", spy);
		const scrim = el.shadowRoot?.querySelector(".scrim") as HTMLElement;
		scrim.dispatchEvent(
			new MouseEvent("click", { bubbles: true, composed: true }),
		);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("does not emit close when the card itself is clicked", async () => {
		const el = mount(true);
		await el.updateComplete;
		const spy = vi.fn();
		el.addEventListener("gcb:modal-close", spy);
		const card = el.shadowRoot?.querySelector(".card") as HTMLElement;
		card.dispatchEvent(
			new MouseEvent("click", { bubbles: true, composed: true }),
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it("restores focus to the previously-active element on close", async () => {
		const trigger = document.createElement("button");
		trigger.textContent = "open";
		document.body.appendChild(trigger);
		trigger.focus();
		expect(document.activeElement).toBe(trigger);

		const el = mount(true);
		await el.updateComplete;

		el.open = false;
		await el.updateComplete;
		// Focus restore is queued via queueMicrotask after updateComplete
		// resolves, so flush one extra microtask before asserting.
		await Promise.resolve();

		expect(document.activeElement).toBe(trigger);
	});
});
