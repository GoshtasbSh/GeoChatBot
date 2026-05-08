# @geochatbot/site

Next.js marketing site for GeoChatBot. Includes:

- `/` — Landing page with differentiators, embed snippet, live demo, eval leaderboard
- `/app` — Full-viewport standalone widget (used by the eval harness)
- `/dashboard` — Headless mode demo with event panel
- `/docs` — Embed guide, Dev API, privacy notes
- `/evals` — Server-rendered eval leaderboard from `EVALS.md`

## Development

```bash
# from repo root
pnpm install

# run dev server
cd packages/site
pnpm dev
```

The site runs on `http://localhost:3000` by default.

## Build

```bash
pnpm build      # from packages/site
# or
pnpm build --filter @geochatbot/site   # from repo root
```

## Deploy

```bash
vercel deploy          # preview
vercel --prod          # production
```

The site is Vercel-ready. Environment variables are not required for the base build.
The widget is loaded lazily on the client; SSR never touches `customElements`.

## Notes

- `@geochatbot/widget` is imported as a workspace package (`workspace:*`).
  Run `pnpm build --filter @geochatbot/widget` first if the widget dist is stale.
- The `/evals` route reads `EVALS.md` from the repo root at build time.
  If the file is missing, a placeholder is shown — the build will not fail.
