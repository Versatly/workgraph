# AGENTS.md

## Cursor Cloud specific instructions

This is a single-package TypeScript library + CLI (`@versatly/workgraph`) for multi-agent coordination. There are no external services, databases, or Docker dependencies.

### Quick reference

- **Package manager:** npm (lockfile: `package-lock.json`)
- **Build:** `npm run build` (uses `tsup`, outputs to `dist/`)
- **Typecheck:** `npm run typecheck` (runs `tsc --noEmit`)
- **Test:** `npm run test` (runs `vitest run`; all 74 tests are filesystem-based using temp dirs — no mocks or external services needed)
- **Full CI:** `npm run ci` (typecheck + test + build, in sequence)
- **CLI entry:** `node bin/workgraph.js` (requires `dist/` from a prior build)

### Caveats

- The CLI (`bin/workgraph.js`) imports from `dist/cli.js`, so you must run `npm run build` before using the CLI directly.
- All tests are self-contained and create/clean up temp directories — they can run in parallel safely.
- The `--workspace` (or `-w`) flag is used to point CLI commands at a workgraph workspace directory. There is no `--root` flag.
- The `thread done` command uses `--output` (not `--summary`) for the result text.
- The optional shared-vault / Tailscale skill feature requires `WORKGRAPH_SHARED_VAULT` env var but is not needed for core development or testing.
