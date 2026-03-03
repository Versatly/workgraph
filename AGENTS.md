# AGENTS.md

## Cursor Cloud specific instructions

This is a TypeScript monorepo for `@versatly/workgraph` (published package + CLI
surface) and package-first agent-native coordination components. There are no
required external services or databases; Docker is optional for local containerized runs.

### Quick reference

- **Package manager (dev/contributor):** pnpm
- **Install dependencies:** `pnpm install`
- **Build (publish surface):** `pnpm run build` (uses `tsup`, outputs to `dist/`)
- **Build workspace packages:** `pnpm -r --if-present run build`
- **Typecheck:** `pnpm run typecheck` (runs `tsc --noEmit`)
- **Test:** `pnpm run test` (runs `vitest run`; tests are filesystem-based using temp dirs)
- **Full CI:** `pnpm run ci` (typecheck + package typecheck + test + build, in sequence)
- **CLI entry:** `node bin/workgraph.js` (requires `dist/` from a prior build)

### Caveats

- The CLI (`bin/workgraph.js`) imports from `dist/cli.js`, so you must run `pnpm run build` before using the CLI directly.
- All tests are self-contained and create/clean up temp directories — they can run in parallel safely.
- The `--workspace` (or `-w`) flag is used to point CLI commands at a workgraph workspace directory. There is no `--root` flag.
- The `thread done` command uses `--output` (not `--summary`) for the result text.
- The optional shared-vault / Tailscale skill feature requires `WORKGRAPH_SHARED_VAULT` env var but is not needed for core development or testing.

### Agent-native engineering workflow

#### Package ownership (package-first)

- `packages/kernel`: core primitive/ledger/thread/workspace domain logic.
- `packages/cli`: command definitions and CLI orchestration only.
- `packages/sdk`: stable developer-facing SDK exports.
- `packages/control-api`, `packages/runtime-adapter-core`, `packages/adapter-*`, `packages/mcp-server`: runtime/control/transport boundaries.
- `packages/policy`, `packages/search-qmd-adapter`, `packages/obsidian-integration`, `packages/skills`, `packages/testkit`: policy/search/integration/skills/test support concerns.

#### Where to add code and tests

- Prefer new production logic in an owning package under `packages/<name>/src`.
- Add tests next to the behavior they cover (for example `packages/<name>/src/**/*.test.ts`).
- Use root-level integration tests under `tests/` for cross-package and published-surface regression coverage.

#### Boundary expectations

- Keep package internals private; import across packages via declared package entrypoints.
- Keep CLI package thin: orchestration and UX only, with business rules in owned domain packages.
- Keep adapters/transport packages free of core domain policy logic unless explicitly owned there.
