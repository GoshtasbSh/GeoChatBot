# ADR 0005 — npm workspaces over pnpm

**Status:** Accepted · 2026-05-08

## Context

The repo is a small monorepo (≤ 4 packages: `widget`, `eval`, `site`, `examples/*`). Both pnpm workspaces and npm workspaces would work. pnpm has objective wins (faster installs, smaller disk via content-addressed store, stricter peer-dep handling).

## Decision

Use **npm workspaces**. The root `package.json` already declares `"workspaces": ["packages/*", "examples/*"]`.

## Consequences

- **Onboarding stays trivial.** `npm install` is what every Node developer already has. Adding pnpm requires a separate install step, a separate lockfile, and CI cache configuration.
- **Scale is small.** At 4 packages, the install-time and disk-space differences are negligible. pnpm's wins start mattering at 10+ packages or with heavy dependency graphs we don't have.
- **CI complexity stays low.** GitHub Actions has first-class `npm ci` caching out of the box.

## Reconsider when

- The repo grows past ~5 packages, or
- We hit hoisting/peer-dep correctness issues that pnpm's strict resolution would prevent, or
- Install time on CI exceeds 90 seconds.

At that point, migrating is a one-day task: `pnpm import`, replace `npm ci` with `pnpm install --frozen-lockfile` in CI, update contributor docs.
