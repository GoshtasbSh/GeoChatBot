import { cn } from "@/lib/utils";

const SNIPPET = `<script type="module"
  src="https://cdn.jsdelivr.net/npm/@geochatbot/widget/dist/geochatbot.js">
</script>

<geo-chatbot dangerously-allow-browser></geo-chatbot>`;

interface Props {
	className?: string;
}

export function EmbedSnippet({ className }: Props) {
	return (
		<div
			className={cn(
				"rounded-xl border border-zinc-200 bg-zinc-950 dark:border-zinc-700",
				className,
			)}
		>
			<div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
				<span className="font-mono text-xs text-zinc-400">HTML</span>
			</div>
			<pre className="overflow-x-auto p-4 text-sm text-zinc-100">
				<code>{SNIPPET}</code>
			</pre>
		</div>
	);
}
