"use client";

import { useEffect, useRef } from "react";

interface Props {
	mode?: "full" | "headless";
	full?: boolean; // when true, sets a 100vh container
	preloadSample?: string; // URL of a sample file to auto-load on mount
	onResult?: (detail: unknown) => void;
}

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
			if (!mounted || !ref.current) return;

			const el = document.createElement("geo-chatbot") as HTMLElement & {
				pushData?: (f: File) => Promise<void>;
			};
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
			// real data in the UI immediately. Non-fatal if it fails.
			if (preloadSample && typeof el.pushData === "function") {
				try {
					const res = await fetch(preloadSample);
					if (res.ok) {
						const name = preloadSample.split("/").pop() ?? "sample.csv";
						const file = new File([await res.blob()], name, {
							type: "text/csv",
						});
						await el.pushData(file);
					}
				} catch {
					// demo still works; it just starts with an empty dataset panel
				}
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
