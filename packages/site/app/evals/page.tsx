import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { marked } from "marked";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
	title: "GeoChatBot — Eval Leaderboard",
	description: "Automated eval results across LLM models.",
};

async function getEvalsContent(): Promise<string | null> {
	try {
		// EVALS.md lives at the repo root, two levels up from packages/site
		const filePath = join(process.cwd(), "../../EVALS.md");
		const content = await readFile(filePath, "utf-8");
		return content.trim() || null;
	} catch {
		return null;
	}
}

export default async function EvalsPage() {
	const content = await getEvalsContent();

	return (
		<div className="min-h-screen bg-white dark:bg-zinc-950">
			<header className="border-b border-zinc-100 dark:border-zinc-800">
				<div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
					<Link
						href="/"
						className="font-mono text-lg font-bold tracking-tight text-zinc-900 dark:text-zinc-50"
					>
						GeoChatBot
					</Link>
					<nav className="flex items-center gap-6 text-sm text-zinc-600 dark:text-zinc-400">
						<Link
							href="/docs"
							className="hover:text-zinc-900 dark:hover:text-zinc-50"
						>
							Docs
						</Link>
						<Link
							href="/app"
							className="hover:text-zinc-900 dark:hover:text-zinc-50"
						>
							App
						</Link>
					</nav>
				</div>
			</header>

			<main className="mx-auto max-w-4xl px-6 py-16">
				<h1 className="mb-2 text-4xl font-bold text-zinc-900 dark:text-zinc-50">
					Eval Leaderboard
				</h1>
				<p className="mb-10 text-zinc-500 dark:text-zinc-400">
					Automated pass-rate and latency scores across LLM models, measured by
					the eval harness in{" "}
					<code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-800">
						packages/eval/
					</code>
					.
				</p>

				{content ? (
					<div
						className="prose prose-zinc max-w-none dark:prose-invert"
						// biome-ignore lint/security/noDangerouslySetInnerHtml: server-only render of repo-root EVALS.md (trusted local file)
						dangerouslySetInnerHTML={{ __html: await marked(content) }}
					/>
				) : (
					<div className="rounded-xl border border-zinc-200 bg-zinc-50 p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
						<p className="text-zinc-500 dark:text-zinc-400">
							No runs yet — see{" "}
							<code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-800">
								packages/eval/README.md
							</code>{" "}
							to run.
						</p>
					</div>
				)}
			</main>
		</div>
	);
}
