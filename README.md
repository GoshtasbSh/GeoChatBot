# GeoChatBot

**Ask plain-English questions about your spatial data — in your browser.**

> No backend. Files never leave your device. Drop-in or headless.

[GIF placeholder: 90-second screencast — to be recorded after Phase 8 deploys to Vercel]

## Embed in 30 seconds

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@geochatbot/widget/dist/geochatbot.js"></script>
<geo-chatbot dangerously-allow-browser></geo-chatbot>
```

That's it. Drop a CSV or GeoJSON, paste a free Groq or Gemini API key (or a paid Anthropic / OpenAI key), ask a question.

## Bring-your-own LLM — including free options

| Provider | Free tier | Models | Where to get a key |
|---|---|---|---|
| **Groq** *(default)* | ✅ free | Llama 3.3 70B, Mixtral 8x7B, Llama 3.1 8B | [console.groq.com/keys](https://console.groq.com/keys) |
| **Google Gemini** | ✅ free | Gemini 2.0 Flash, 1.5 Pro, 1.5 Flash | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| Anthropic | paid | Claude Sonnet 4.6, Haiku 4.5, Opus 4.7 | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| OpenAI | $5 sign-up credit | GPT-4o mini, GPT-4o, GPT-4 Turbo | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |

Pick a provider in the in-widget settings drawer (⚙ icon) — your key stays in `localStorage` and is sent only to the provider you choose. Free-tier reality: Groq and Gemini have no per-token charge but you still register for an API key.

## Why this is different

1. **Browser-only** — files never leave the user's device; DuckDB-WASM does the analysis locally.
2. **Plan before action** — every agent run emits a numbered plan that the user approves; no surprise queries.
3. **Self-healing** — when a step fails, a Critic loop diagnoses + patches up to 2× before giving up.
4. **Drop-in or headless** — one `<script>` tag for full UI; `mode="headless"` emits events into your existing dashboard.

## Eval leaderboard

| Model | Pass rate | Mean latency |
|---|---|---|
| _placeholder until Phase 7 runs_ | — | — |

Full leaderboard at [`/evals`](https://geochatbot.example.com/evals) once deployed; methodology in [`packages/eval/README.md`](packages/eval/README.md).

## Demo & docs

- **Live demo:** [geochatbot.example.com](https://geochatbot.example.com) (post-deploy)
- **Standalone app:** [/app](https://geochatbot.example.com/app)
- **Headless dashboard demo:** [/dashboard](https://geochatbot.example.com/dashboard)
- **Embed guide + dev API:** [/docs](https://geochatbot.example.com/docs)
- **Eval leaderboard:** [/evals](https://geochatbot.example.com/evals)

## Project layout

| Package | Description |
|---|---|
| `packages/widget/` | The web component — TypeScript + Lit + DuckDB-WASM + MapLibre |
| `packages/site/` | Next.js marketing site + standalone `/app` (Vercel-ready) |
| `packages/eval/` | Python + Playwright eval harness (`packages/eval/README.md`) |

## License

MIT.
