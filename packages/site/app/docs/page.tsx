import type { Metadata } from 'next';
import Link from 'next/link';
import { EmbedSnippet } from '@/components/embed-snippet';
import { Separator } from '@/components/ui/separator';

export const metadata: Metadata = {
  title: 'GeoChatBot — Docs',
  description: 'Embed guide, Dev API, and privacy notes for GeoChatBot.',
};

const DEV_API = `const bot = document.querySelector('geo-chatbot') as any;

// Ingest
bot.pushData(file: File);
bot.pushData({ name: 'sales', rows: [...], geometry?: {...} });

// LLM provider — pick any of: 'groq' (free, default), 'gemini' (free), 'anthropic', 'openai'.
bot.setProvider({ name: 'anthropic', apiKey: 'sk-ant-…', model: 'claude-sonnet-4-6' });
// In practice, end users open the in-widget settings drawer (⚙ icon) and
// paste their key there — it persists to localStorage and is sent only
// to the provider they pick. The drawer defaults to Groq (free tier).

// Ask
await bot.ask('How many points fall within 500 m of each school?');
bot.approvePlan();           // user-driven gate
bot.rejectPlan({ feedback: '...' });

// Mode
bot.setMode('full');         // default; widget renders its own UI
bot.setMode('headless');     // suppress UI, emit events for the host

// Events (typed via .on())
bot.on('plan',     (d) => { /* d.plan, d.planId, d.datasets */ });
bot.on('progress', (d) => { /* d.stepId, d.status, d.durationMs?, d.error? */ });
bot.on('result',   (d) => { /* d.kind: 'layer'|'chart'|'table'|'summary' */ });
bot.on('error',    (d) => { /* d.message, d.code? */ });
bot.on('critic',   (d) => { /* d.attempt, d.maxAttempts, d.decision, d.errorMessage */ });

// Reset
bot.clear();`;

export default function DocsPage() {
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
            <Link href="/app" className="hover:text-zinc-900 dark:hover:text-zinc-50">
              App
            </Link>
            <Link href="/evals" className="hover:text-zinc-900 dark:hover:text-zinc-50">
              Evals
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-16 px-6 py-16">
        {/* Section 1: Embed */}
        <section>
          <h1 className="mb-2 text-4xl font-bold text-zinc-900 dark:text-zinc-50">
            Docs
          </h1>
          <p className="mb-10 text-zinc-500 dark:text-zinc-400">
            Everything you need to embed GeoChatBot in your site or app.
          </p>

          <h2 className="mb-4 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            Embed
          </h2>
          <p className="mb-6 text-zinc-600 dark:text-zinc-400">
            Add two lines to any HTML page — no bundler required.
          </p>
          <EmbedSnippet />
          <div className="mt-6 space-y-3 text-sm text-zinc-600 dark:text-zinc-400">
            <p>
              The{' '}
              <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-800">
                dangerously-allow-browser
              </code>{' '}
              attribute enables the built-in settings drawer where the user can
              paste their own API key. The key is stored only in{' '}
              <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-800">
                localStorage
              </code>{' '}
              and never sent to any server.
            </p>
            <p>
              Without this attribute the widget requires a key to be provided
              programmatically via{' '}
              <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-800">
                bot.setProvider(...)
              </code>
              .
            </p>
          </div>
        </section>

        <Separator />

        {/* Section 1.5: Providers */}
        <section>
          <h2 className="mb-4 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            LLM providers
          </h2>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Bring your own key. The widget defaults to Groq (free tier);
            users pick a different provider in the in-widget settings
            drawer. The selected key is stored in <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-800">localStorage</code>{' '}
            and sent only to the provider they choose — never to a
            GeoChatBot server (there isn&apos;t one).
          </p>
          <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 dark:bg-zinc-900">
                <tr className="text-left">
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 font-medium">Free tier</th>
                  <th className="px-4 py-2 font-medium">Recommended model</th>
                  <th className="px-4 py-2 font-medium">Get a key</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                <tr>
                  <td className="px-4 py-2 font-medium">Groq <span className="text-xs text-zinc-500">(default)</span></td>
                  <td className="px-4 py-2"><span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100">FREE</span></td>
                  <td className="px-4 py-2 font-mono text-xs">llama-3.3-70b-versatile</td>
                  <td className="px-4 py-2"><a href="https://console.groq.com/keys" className="text-indigo-600 underline" target="_blank" rel="noopener">console.groq.com/keys</a></td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-medium">Google Gemini</td>
                  <td className="px-4 py-2"><span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100">FREE</span></td>
                  <td className="px-4 py-2 font-mono text-xs">gemini-2.0-flash</td>
                  <td className="px-4 py-2"><a href="https://aistudio.google.com/app/apikey" className="text-indigo-600 underline" target="_blank" rel="noopener">aistudio.google.com/app/apikey</a></td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-medium">Anthropic</td>
                  <td className="px-4 py-2 text-zinc-500">paid</td>
                  <td className="px-4 py-2 font-mono text-xs">claude-sonnet-4-6</td>
                  <td className="px-4 py-2"><a href="https://console.anthropic.com/settings/keys" className="text-indigo-600 underline" target="_blank" rel="noopener">console.anthropic.com</a></td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-medium">OpenAI</td>
                  <td className="px-4 py-2 text-zinc-500">$5 sign-up credit</td>
                  <td className="px-4 py-2 font-mono text-xs">gpt-4o-mini</td>
                  <td className="px-4 py-2"><a href="https://platform.openai.com/api-keys" className="text-indigo-600 underline" target="_blank" rel="noopener">platform.openai.com</a></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <Separator />

        {/* Section 2: Dev API */}
        <section>
          <h2 className="mb-4 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            Dev API
          </h2>
          <p className="mb-6 text-zinc-600 dark:text-zinc-400">
            Full programmatic API for host applications. All methods are
            available on the{' '}
            <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-800">
              &lt;geo-chatbot&gt;
            </code>{' '}
            element.
          </p>
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-950 dark:border-zinc-700">
            <div className="border-b border-zinc-800 px-4 py-2">
              <span className="font-mono text-xs text-zinc-400">TypeScript</span>
            </div>
            <pre className="overflow-x-auto p-4 text-sm text-zinc-100">
              <code>{DEV_API}</code>
            </pre>
          </div>
        </section>

        <Separator />

        {/* Section 3: Privacy & safety */}
        <section>
          <h2 className="mb-4 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            Privacy &amp; safety
          </h2>
          <ul className="space-y-3 text-sm text-zinc-600 dark:text-zinc-400">
            <li className="flex gap-3">
              <span className="text-green-500">✓</span>
              <span>
                <strong className="text-zinc-900 dark:text-zinc-50">
                  Files never leave the browser.
                </strong>{' '}
                All file parsing and SQL execution happens locally in DuckDB-WASM
                running in a Web Worker. Nothing is uploaded.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-green-500">✓</span>
              <span>
                <strong className="text-zinc-900 dark:text-zinc-50">
                  API key stored only in localStorage.
                </strong>{' '}
                The key is read directly by the browser and sent only to the LLM
                provider endpoint you configure. No proxy server.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-green-500">✓</span>
              <span>
                <strong className="text-zinc-900 dark:text-zinc-50">
                  SELECT / WITH only.
                </strong>{' '}
                The SQL validator rejects any statement that is not a{' '}
                <code className="font-mono text-xs">SELECT</code> or{' '}
                <code className="font-mono text-xs">WITH</code> query before
                execution.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-green-500">✓</span>
              <span>
                <strong className="text-zinc-900 dark:text-zinc-50">
                  Tool args validated via Zod.
                </strong>{' '}
                Every argument the LLM passes to a tool is validated against a
                Zod schema before the tool runs.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-green-500">✓</span>
              <span>
                <strong className="text-zinc-900 dark:text-zinc-50">
                  Executors run in a Web Worker.
                </strong>{' '}
                DuckDB and plan execution are sandboxed in a dedicated Worker
                thread, isolated from the main UI thread.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-green-500">✓</span>
              <span>
                <strong className="text-zinc-900 dark:text-zinc-50">
                  No telemetry.
                </strong>{' '}
                The widget does not collect usage data, analytics, or error
                reports.
              </span>
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
