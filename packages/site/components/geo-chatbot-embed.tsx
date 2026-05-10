"use client";

import { useEffect, useRef } from "react";

interface Props {
	mode?: "full" | "headless";
	full?: boolean; // when true, sets a 100vh container
	onResult?: (detail: unknown) => void;
}

export function GeoChatBotEmbed({ mode = "full", full, onResult }: Props) {
	const ref = useRef<HTMLDivElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount once per mode; wiring onResult again would duplicate listeners
	useEffect(() => {
		let mounted = true;

		(async () => {
			// Lazy import the widget bundle so SSR doesn't choke on `customElements`.
			await import("@geochatbot/widget");
			if (!mounted || !ref.current) return;

			const el = document.createElement("geo-chatbot");
			if (mode === "headless") el.setAttribute("mode", "headless");
			ref.current.appendChild(el);

			if (onResult) {
				el.addEventListener("result", (e: Event) =>
					onResult((e as CustomEvent).detail),
				);
			}
		})();

		return () => {
			mounted = false;
			if (ref.current) ref.current.replaceChildren();
		};
	}, [mode]);

	return (
		<div ref={ref} className={full ? "h-[100vh] w-full" : "h-[600px] w-full"} />
	);
}
