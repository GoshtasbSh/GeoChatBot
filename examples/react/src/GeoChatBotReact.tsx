import {
	type Ref,
	forwardRef,
	useEffect,
	useImperativeHandle,
	useRef,
} from "react";
// Side-effect import: registers the <geo-chatbot> custom element.
import "@geochatbot/widget";
import type {
	GeoChatBotEvents,
	GeoChatBotElement as WidgetElement,
} from "@geochatbot/widget";

import "./geo-chatbot.d";

type Theme = "light" | "dark";

export type { GeoChatBotEvents };

/**
 * Minimum surface of <geo-chatbot> consumed by this wrapper. We re-use
 * the published `GeoChatBotElement` class type from `@geochatbot/widget`
 * so subscribers receive fully-typed event payloads instead of `unknown`.
 */
export type GeoChatBotElement = WidgetElement;

export interface GeoChatBotReactProps {
	theme?: Theme;
	mode?: "full" | "headless";
	onDatasetLoaded?: (payload: GeoChatBotEvents["dataset-loaded"]) => void;
	onPlan?: (payload: GeoChatBotEvents["plan"]) => void;
	onProgress?: (payload: GeoChatBotEvents["progress"]) => void;
	onResult?: (payload: GeoChatBotEvents["result"]) => void;
	onError?: (payload: GeoChatBotEvents["error"]) => void;
	style?: React.CSSProperties;
	className?: string;
}

export const GeoChatBotReact = forwardRef<
	GeoChatBotElement,
	GeoChatBotReactProps
>(function GeoChatBotReact(props, ref: Ref<GeoChatBotElement>) {
	const {
		theme = "light",
		mode,
		onDatasetLoaded,
		onPlan,
		onProgress,
		onResult,
		onError,
		style,
		className,
	} = props;
	const innerRef = useRef<GeoChatBotElement | null>(null);

	useImperativeHandle<GeoChatBotElement | null, GeoChatBotElement | null>(
		ref,
		() => innerRef.current,
		[],
	);

	useEffect(() => {
		const el = innerRef.current;
		if (!el || typeof el.on !== "function") return;
		if (mode) el.setMode(mode);
		const unsubs: Array<() => void> = [];
		if (onDatasetLoaded) unsubs.push(el.on("dataset-loaded", onDatasetLoaded));
		if (onPlan) unsubs.push(el.on("plan", onPlan));
		if (onProgress) unsubs.push(el.on("progress", onProgress));
		if (onResult) unsubs.push(el.on("result", onResult));
		if (onError) unsubs.push(el.on("error", onError));
		return () => {
			for (const u of unsubs) {
				try {
					u();
				} catch {
					/* ignore */
				}
			}
		};
	}, [mode, onDatasetLoaded, onPlan, onProgress, onResult, onError]);

	return (
		<geo-chatbot
			ref={innerRef as unknown as Ref<HTMLElement>}
			theme={theme}
			style={style}
			className={className}
		/>
	);
});
