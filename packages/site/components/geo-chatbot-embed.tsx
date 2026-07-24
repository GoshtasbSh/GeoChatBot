"use client";

import { useEffect, useRef } from "react";

interface Props {
	mode?: "full" | "headless";
	full?: boolean; // when true, sets a 100vh container
	preloadSample?: string; // URL of a sample file to auto-load on mount
	onResult?: (detail: unknown) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type WidgetEl = HTMLElement & { pushData?: (f: File) => Promise<void> };

export function GeoChatBotEmbed({
	mode = "full",
	full,
	preloadSample,
	onResult,
}: Props) {
	const ref = useRef<HTMLDivElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount once per mode/sample; wiring onResult again would duplicate listeners
	useEffect(() => {
		let mounted = true;

		(async () => {
			// Lazy import the widget bundle so SSR doesn't choke on `customElements`.
			await import("@geochatbot/widget");
			// Wait until the custom element is actually defined before creating it,
			// so its methods (pushData) are guaranteed to exist after upgrade.
			await customElements.whenDefined("geo-chatbot");
			if (!mounted || !ref.current) return;

			const el = document.createElement("geo-chatbot") as WidgetEl;
			if (mode === "headless") el.setAttribute("mode", "headless");
			// Bring-your-own-key: the visitor's own key is stored in their
			// localStorage and sent only to the provider they choose, directly
			// from their browser. Required for the zero-backend public demo.
			el.setAttribute("dangerously-allow-browser", "");
			el.setAttribute("agentic-mode", "agentic");
			ref.current.appendChild(el);

			if (onResult) {
				el.addEventListener("result", (e: Event) =>
					onResult((e as CustomEvent).detail),
				);
			}

			// Preload a sample dataset so a visitor with no API key still sees
			// real data in the UI within a couple of seconds. Robust against the
			// element not being fully upgraded yet, and retries a transient
			// DuckDB cold-start failure a few times before giving up.
			if (!preloadSample) return;
			try {
				const res = await fetch(preloadSample);
				if (!res.ok) return;
				const name = preloadSample.split("/").pop() ?? "sample.csv";
				const type = name.endsWith(".geojson")
					? "application/geo+json"
					: name.endsWith(".json")
						? "application/json"
						: "text/csv";
				const file = new File([await res.blob()], name, { type });

				// Wait for pushData to exist (element upgrade may lag createElement).
				for (let i = 0; i < 40 && mounted; i++) {
					if (typeof el.pushData === "function") break;
					await sleep(100);
				}
				if (!mounted || typeof el.pushData !== "function") return;

				// Retry the ingest itself (DuckDB-WASM cold start can throw once).
				for (let attempt = 0; attempt < 4 && mounted; attempt++) {
					try {
						await el.pushData(file);
						return;
					} catch {
						await sleep(400);
					}
				}
			} catch {
				// Non-fatal: the demo still works, the visitor can drop a file.
			}
		})();

		return () => {
			mounted = false;
			if (ref.current) ref.current.replaceChildren();
		};
	}, [mode, preloadSample]);

	return (
		<div ref={ref} className={full ? "h-[100vh] w-full" : "h-[600px] w-full"} />
	);
}
