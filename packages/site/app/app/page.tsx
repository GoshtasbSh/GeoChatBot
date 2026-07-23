import { GeoChatBotEmbed } from "@/components/geo-chatbot-embed";
import type { Metadata } from "next";

export const metadata: Metadata = {
	title: "GeoChatBot — App",
	description: "Full-screen GeoChatBot spatial analysis agent.",
};

export default function AppPage() {
	return (
		<div className="flex h-screen w-full flex-col overflow-hidden bg-white dark:bg-zinc-950">
			<GeoChatBotEmbed full preloadSample="/samples/nyc311.csv" />
		</div>
	);
}
