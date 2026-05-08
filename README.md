# GeoChatBot

Embeddable chatbot widget for **in-browser** spatial and tabular data analysis. Drop it into any website with one `<script>` tag; users upload CSV / GeoJSON and ask questions in plain English. An LLM agent inspects the data, proposes a plan, *waits for the user's approval*, then executes the plan as SQL against DuckDB-WASM (with the `spatial` extension) and renders results as map layers, charts, tables, and written summaries.

**Zero data server.** Files never leave the user's browser. The only network call is to the LLM provider, using the user's own API key (BYO).

## Differentiators

1. **Pure browser data plane** — uploaded files never leave the device.
2. **Embeddable Web Component + headless mode** — a host dashboard can `pushData()` and consume `result` events to drop the agent's output layers into its own map.
3. **Plan-then-execute with explicit approval gate** — the agent shows its plan and only runs after the user clicks Approve.
4. **BYO key, free hosting** — works on any static host. No backend required.

## Status

| Phase | State |
|---|---|
| 0 — workspace | done |
| 1 — data + engine + map | in progress (drop GeoJSON → see map ✅) |
| 2 — public dev API + headless mode | next |
| 3 — LLM provider + BYO key UI | pending |
| 4 — planner + plan UI + approval gate | pending |
| 5 — executors + renderers | pending |
| 6 — critic loop | pending |
| 7 — eval harness | pending |
| 8 — site + README + demo video | pending |

See [PLAN.md](./PLAN.md) for the full phased roadmap, initial prompts per phase, and the 90-second screencast script.

## Quick start (dev)

```bash
npm install
npm run dev --workspace=@geochatbot/widget
# open http://localhost:5173 — drop a GeoJSON or click a fixture
```

## Build the embed bundle

```bash
npm run build --workspace=@geochatbot/widget
# packages/widget/dist/geochatbot.js  ← ESM bundle
# examples/standalone/index.html      ← consumes the built bundle
```

## Repository layout

```
packages/
  widget/    The embeddable Web Component (<geo-chatbot>)
examples/
  standalone/  Vanilla HTML page that loads the built widget
PLAN.md      Phased roadmap (read this before adding features)
```

## License

MIT
