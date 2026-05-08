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
| 3 — LLM provider + BYO key UI | done |
| 4 — planner + plan UI + approval gate | done ([plan](./docs/superpowers/plans/2026-05-08-phase-4-planner.md)) |
| 5 — executors + renderers | next |
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
# packages/widget/dist/geochatbot.js       ← ESM bundle
# packages/widget/dist/geochatbot.umd.cjs  ← UMD bundle (window.GeoChatBot)
```

Print bundle sizes (raw + gzipped ESM):

```bash
npm run build:size --workspace=@geochatbot/widget
```

## Embed forms

### 1. `<script src>` (UMD, no bundler)

```html
<script src="/path/to/geochatbot.umd.cjs"></script>
<geo-chatbot theme="light"></geo-chatbot>
<script>
  const bot = document.querySelector('geo-chatbot');
  bot.on('result', (r) => console.log(r));
  bot.setProvider(GeoChatBot.createEcho());
</script>
```

The UMD bundle exposes `window.GeoChatBot` and registers `<geo-chatbot>` via
side effect. Serve over HTTP (not `file://`) so the DuckDB-WASM workers/wasm
load correctly from siblings of the bundle.

### 2. ESM (with a bundler)

```ts
import '@geochatbot/widget';                  // registers <geo-chatbot>
import { createEcho } from '@geochatbot/widget';

const bot = document.querySelector('geo-chatbot')!;
bot.setProvider(createEcho());
const off = bot.on('result', (r) => console.log(r));
// off() to unsubscribe
```

### 3. React

```tsx
import '@geochatbot/widget';
import { createEcho } from '@geochatbot/widget';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'geo-chatbot': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { theme?: 'light' | 'dark' },
        HTMLElement
      >;
    }
  }
}

export function MyView() {
  return <geo-chatbot theme="dark" />;
}
```

A working wrapper with refs and typed `on('result' | 'error' | 'plan')`
subscriptions lives in `examples/react/`.

### Theming

The widget honors a `theme="light" | "dark"` attribute and exposes CSS
custom properties on the host:

```html
<geo-chatbot theme="dark" style="--gcb-accent: #a855f7;"></geo-chatbot>
```

## End-to-end tests

```bash
npm run e2e:install   # one-time: downloads Chromium for Playwright
npm run e2e           # runs Playwright against the demo workspace
```

## Repository layout

```
packages/
  widget/             Embeddable Web Component (<geo-chatbot>)
  demo/               Local demo app (drop file → see table + map)
examples/
  standalone/         ESM-form embed example
  standalone-cdn/     <script src> (UMD) embed example
  react/              React + Vite example
e2e/                  Playwright end-to-end tests
PLAN.md               Phased roadmap (read this before adding features)
```

## License

MIT
