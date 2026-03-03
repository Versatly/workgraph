# WorkGraph Monorepo Migration Notes

This repository now uses pnpm workspaces while preserving compatibility for
existing `@versatly/workgraph` npm consumers.

## What stayed stable

- Package name remains `@versatly/workgraph`.
- Existing CLI entrypoint still works: `workgraph`.
- Existing JSON command envelope remains:
  - success: `{ "ok": true, "data": ... }`
  - error: `{ "ok": false, "error": "..." }`

## What changed

- Internal code is split into workspace packages under `packages/*`.
- Active adapter/integration workspace packages now include both runtime adapters:
  - `packages/adapter-claude-code`
  - `packages/adapter-cursor-cloud`
  - `packages/mcp-server`
- Legacy root `src/` wrappers were removed; package-owned modules are canonical.
- Versioned contracts now live under `schemas/`.
- New commands added for PRD gap closure:
  - `status`, `brief`, `query`, `search`, `checkpoint`, `intake`
  - `board generate|sync`, `graph index|hygiene`
  - `policy party ...`, `dispatch ...`, `onboard`

## Developer workflow

```bash
pnpm install
pnpm run ci
```

## CI / automation workflow

- GitHub Actions CI now runs pnpm with frozen lockfile installs.
- Canonical validation command remains:

```bash
pnpm run ci
```

## Demo workspace generation

You can generate the large Obsidian demo vault with:

```bash
pnpm run demo:workspace
pnpm run demo:obsidian-setup
```
