# AGENTS.md

## Cursor Cloud specific instructions

This is a TypeScript monorepo (`@versatly/workgraph`) for multi-agent coordination. The root package provides a library + CLI; sub-packages live under `packages/*`. There are no external services, databases, or Docker dependencies required for development.

### Quick reference

- **Package manager:** npm with workspaces (lockfile: `package-lock.json`)
- **Build:** `npm run build` (uses `tsup`, outputs to `dist/`)
- **Typecheck:** `npm run typecheck` (runs `tsc --noEmit`)
- **Test:** `npm run test` (runs `vitest run`; 326 tests across 56 files, all filesystem-based using temp dirs)
- **Full CI:** `npm run ci` (typecheck + typecheck:packages + test + build)
- **CLI entry:** `node bin/workgraph.js` (requires `dist/` from a prior build)
- **Workspace packages test:** `npm run test:packages` / `npm run typecheck:packages`

### Caveats

- **workspace:* protocol:** The `package.json` files use `workspace:*` (pnpm syntax) for inter-package deps, but the project uses npm. The update script strips these before `npm install` since npm resolves workspace packages automatically via the `workspaces` field. After install, originals are restored via `git checkout`.
- The CLI (`bin/workgraph.js`) imports from `dist/cli.js`, so you must run `npm run build` before using the CLI directly.
- All tests are self-contained and create/clean up temp directories — they can run in parallel safely.
- The `--workspace` (or `-w`) flag is used to point CLI commands at a workgraph workspace directory. There is no `--root` flag.
- The `thread done` command uses `--output` (not `--summary`) for the result text.
- The optional shared-vault / Tailscale skill feature requires `WORKGRAPH_SHARED_VAULT` env var but is not needed for core development or testing.
