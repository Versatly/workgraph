# WorkGraph Monorepo Migration Notes

This repository now uses npm workspaces while preserving compatibility for
existing `@versatly/workgraph` npm consumers.

## What stayed stable

- Package name remains `@versatly/workgraph`.
- Existing CLI entrypoint still works: `workgraph`.
- Existing JSON command envelope remains:
  - success: `{ "ok": true, "data": ... }`
  - error: `{ "ok": false, "error": "..." }`

## What changed

- Internal code is split into workspace packages under `packages/*`.
- Versioned contracts now live under `schemas/`.
- New commands added for PRD gap closure:
  - `status`, `brief`, `query`, `search`, `checkpoint`, `intake`
  - `board generate|sync`, `graph index|hygiene`
  - `policy party ...`, `dispatch ...`, `onboard`

## Developer workflow

```bash
npm install
npm run ci
```

## Demo workspace generation

You can generate the large Obsidian demo vault with:

```bash
npm run demo:workspace
npm run demo:obsidian-setup
```
