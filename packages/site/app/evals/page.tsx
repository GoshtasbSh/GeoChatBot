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
					<div className="space-y-6">
						<h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
							Methodology
						</h2>
						<p className="text-zinc-600 dark:text-zinc-400">
							The harness drives the real widget through a headless browser
							(Playwright) against a fixed task set, injecting each model via
							bring-your-own-key and scoring the agent&rsquo;s output for
							correctness and latency — no mocks, the full plan-then-execute
							loop against DuckDB-WASM.
						</p>
						<ul className="list-inside list-disc space-y-2 text-zinc-600 dark:text-zinc-400">
							<li>
								<span className="font-medium text-zinc-800 dark:text-zinc-200">
									Tasks
								</span>{" "}
								— plain-English questions with expected result shapes (e.g.{" "}
								<code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-800">
									tasks/nyc_311_v1.json
								</code>
								).
							</li>
							<li>
								<span className="font-medium text-zinc-800 dark:text-zinc-200">
									Score
								</span>{" "}
								— per-task pass/fail from the produced map/chart/table/answer,
								plus wall-clock latency.
							</li>
							<li>
								<span className="font-medium text-zinc-800 dark:text-zinc-200">
									Output
								</span>{" "}
								— a leaderboard table that renders here automatically once a run
								is committed.
							</li>
						</ul>
						<p className="text-zinc-600 dark:text-zinc-400">
							Harness, tasks, and scorer are open in{" "}
							<a
								href="https://github.com/GoshtasbSh/GeoChatBot/tree/main/packages/eval"
								target="_blank"
								rel="noopener noreferrer"
								className="underline hover:text-zinc-900 dark:hover:text-zinc-50"
							>
								packages/eval
							</a>
							.
						</p>
					</div>
				)}
			</main>
		</div>
	);
}
