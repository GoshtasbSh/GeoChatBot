import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { EmbedSnippet } from '@/components/embed-snippet';
import { GeoChatBotEmbed } from '@/components/geo-chatbot-embed';

const DIFFERENTIATORS = [
  {
    title: 'Browser-only',
    description:
      'Files never leave the user\'s device; DuckDB-WASM does the analysis locally.',
    icon: '🔒',
  },
  {
    title: 'Plan before action',
    description:
      'Every agent run emits a numbered plan that the user approves; no surprise queries.',
    icon: '📋',
  },
  {
    title: 'Self-healing',
    description:
      'When a step fails, a Critic loop diagnoses + patches up to 2× before giving up.',
    icon: '🔧',
  },
  {
    title: 'Drop-in or headless',
    description:
      'One <script> tag for full UI; mode="headless" emits events into your existing dashboard.',
    icon: '🧩',
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950">
      {/* Nav */}
      <header className="border-b border-zinc-100 dark:border-zinc-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="font-mono text-lg font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            GeoChatBot
          </span>
          <nav className="flex items-center gap-6 text-sm text-zinc-600 dark:text-zinc-400">
            <Link href="/docs" className="hover:text-zinc-900 dark:hover:text-zinc-50">
              Docs
            </Link>
            <Link href="/evals" className="hover:text-zinc-900 dark:hover:text-zinc-50">
              Evals
            </Link>
            <Link href="/dashboard" className="hover:text-zinc-900 dark:hover:text-zinc-50">
              Demo
            </Link>
            <Button asChild size="sm">
              <Link href="/app">Try it now</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-6xl px-6 py-24 text-center">
          <Badge variant="secondary" className="mb-6">
            Browser-native spatial agent
          </Badge>
          <h1 className="mb-6 text-5xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 sm:text-6xl">
            Ask plain-English questions about your{' '}
            <span className="text-zinc-500">spatial data</span> — in your browser.
          </h1>
          <p className="mx-auto mb-10 max-w-2xl text-xl text-zinc-500 dark:text-zinc-400">
            No backend. Files never leave your device. Drop-in or headless.
          </p>
          <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Button asChild size="lg">
              <Link href="/app">Try it now</Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <a
                href="https://github.com/example/geochatbot"
                target="_blank"
                rel="noopener noreferrer"
              >
                View on GitHub
              </a>
            </Button>
          </div>
        </section>

        <Separator />

        {/* Differentiators */}
        <section className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="mb-12 text-center text-3xl font-bold text-zinc-900 dark:text-zinc-50">
            Why this is different
          </h2>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {DIFFERENTIATORS.map((d) => (
              <Card key={d.title}>
                <CardHeader>
                  <div className="mb-2 text-3xl">{d.icon}</div>
                  <CardTitle className="text-base">{d.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <CardDescription>{d.description}</CardDescription>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <Separator />

        {/* Embed in 30 seconds */}
        <section className="mx-auto max-w-4xl px-6 py-20">
          <h2 className="mb-4 text-3xl font-bold text-zinc-900 dark:text-zinc-50">
            Embed in 30 seconds
          </h2>
          <p className="mb-8 text-zinc-500 dark:text-zinc-400">
            Drop a CSV or GeoJSON, paste your Anthropic key, ask a question.
            That&apos;s it.
          </p>
          <EmbedSnippet />
          <p className="mt-4 text-sm text-zinc-400">
            See{' '}
            <Link href="/docs" className="underline hover:text-zinc-700">
              /docs
            </Link>{' '}
            for the full Dev API and headless mode.
          </p>
        </section>

        <Separator />

        {/* Live demo */}
        <section className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="mb-4 text-3xl font-bold text-zinc-900 dark:text-zinc-50">
            Live demo
          </h2>
          <p className="mb-8 text-zinc-500 dark:text-zinc-400">
            The full widget running right here. Upload a file and ask a question.
          </p>
          <GeoChatBotEmbed />
        </section>

        <Separator />

        {/* Eval leaderboard */}
        <section className="mx-auto max-w-4xl px-6 py-20">
          <h2 className="mb-4 text-3xl font-bold text-zinc-900 dark:text-zinc-50">
            Eval leaderboard
          </h2>
          <p className="mb-8 text-zinc-500 dark:text-zinc-400">
            Pass rates and latencies across models, measured by the automated
            eval harness.
          </p>
          <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Model
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Pass rate
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Mean latency
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td
                    colSpan={3}
                    className="px-4 py-8 text-center text-zinc-400"
                  >
                    Placeholder — run{' '}
                    <code className="font-mono text-xs">
                      packages/eval/README.md
                    </code>{' '}
                    to populate.{' '}
                    <Link href="/evals" className="underline hover:text-zinc-700">
                      Full leaderboard
                    </Link>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-100 dark:border-zinc-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-8 text-sm text-zinc-500">
          <span>
            MIT license &mdash; GeoChatBot {new Date().getFullYear()}
          </span>
          <a
            href="https://github.com/example/geochatbot"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-zinc-900 dark:hover:text-zinc-50"
          >
            GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
