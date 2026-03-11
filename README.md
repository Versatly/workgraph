# @versatly/workgraph

Agent-first workgraph workspace for multi-agent collaboration.

`@versatly/workgraph` is the standalone coordination core for multi-agent execution. It focuses only on:

- Dynamic primitive registry (`thread`, `space`, `decision`, `lesson`, `fact`, `agent`, plus custom types)
- Append-only event ledger (`.workgraph/ledger.jsonl`)
- Ledger claim index (`.workgraph/ledger-index.json`) for fast ownership queries
- Tamper-evident ledger hash-chain (`.workgraph/ledger-chain.json`)
- Markdown-native primitive store
- Thread lifecycle coordination (claim/release/block/unblock/done/decompose)
- Space-scoped thread scheduling (`--space`)
- Generated markdown command center (`workgraph command-center`)
- Native skill primitive lifecycle (`workgraph skill write/load/propose/promote`)
- Primitive-registry manifest + auto-generated `.base` files
- Orientation loop commands (`workgraph status/brief/checkpoint/intake`)
- Deterministic context lenses (`workgraph lens list/show`) for real-time situational awareness
- Multi-filter primitive query (`workgraph query ...`)
- Core + QMD-compatible keyword search (`workgraph search ...`)
- Obsidian Kanban board generation/sync (`workgraph board generate|sync`)
- Wiki-link graph intelligence (`workgraph graph index|hygiene|neighborhood|impact|context|edges|export`)
- Policy party registry and sensitive transition gates
- Programmatic dispatch contract (`workgraph dispatch ...`) with explicit status transitions, lease heartbeats, and timeout-aware adapter cancellation
- Programmable trigger engine with composable conditions, idempotent dispatch bridging, and safety-gated high-impact actions
- MCP write surface for trigger CRUD/fire, dispatch, autonomy, and mission orchestration
- JSON-friendly CLI for agent orchestration

No memory-category scaffolding, no qmd dependency, no observational-memory pipeline.

## Install

```bash
npm install @versatly/workgraph
```

Or global CLI:

```bash
npm install -g @versatly/workgraph
```

## Agent-first CLI

```bash
# Initialize pure workgraph workspace
workgraph init ./wg-space --json

# Define custom primitive
workgraph primitive define command-center \
  --description "Agent ops cockpit" \
  --fields owner:string \
  --fields panel_refs:list \
  --json

# Create and route thread work
workgraph thread create "Ship command center" \
  --goal "Production-ready multi-agent command center" \
  --priority high \
  --actor agent-lead \
  --json

workgraph thread next --claim --actor agent-worker --json
workgraph status --json
workgraph brief --actor agent-worker --json
workgraph lens list --json
workgraph lens show my-work --actor agent-worker --json
workgraph query --type thread --status open --limit 10 --json
workgraph search "auth" --mode auto --json
workgraph checkpoint "Completed API layer" --next "implement tests" --actor agent-worker --json
workgraph board generate --output "ops/Workgraph Board.md" --json
workgraph graph hygiene --json
workgraph graph neighborhood ship-feature --depth 2 --json
workgraph graph impact ship-feature --json
workgraph graph context ship-feature --budget 2000 --json
workgraph graph edges ship-feature --json
workgraph graph export ship-feature --depth 2 --format md --json
workgraph dispatch create "Review blockers" --actor agent-lead --json
workgraph dispatch mark run_123 --status succeeded --output "Review complete" --actor agent-lead --json
workgraph dispatch create-execute "Close all ready threads in platform space" \
  --actor agent-lead \
  --agents agent-a,agent-b,agent-c \
  --space spaces/platform \
  --json
workgraph trigger fire triggers/escalate-blocked.md --event-key "thread-blocked-001" --actor agent-lead --json
workgraph onboarding update onboarding/onboarding-for-agent-architect.md --status paused --actor agent-lead --json
workgraph mcp serve -w /path/to/workspace --actor agent-ops --read-only
workgraph ledger show --count 20 --json
workgraph command-center --output "ops/Command Center.md" --json
workgraph bases generate --refresh-registry --json
```

### JSON contract

All commands support `--json` and emit:

- Success: `{ "ok": true, "data": ... }`
- Failure: `{ "ok": false, "error": "..." }` (non-zero exit)

This is intended for robust parsing by autonomous agents.

### Monorepo layout

The repository is now fully organized as a pnpm workspaces monorepo while preserving
the published `@versatly/workgraph` package compatibility surface.

Legacy root `src/` compatibility wrappers have been removed. Package-owned modules
under `packages/*` are the only implementation source of truth.

Key workspace packages:

- `packages/kernel` — domain state machine and coordination core
- `packages/cli` — command surface over kernel workflows
- `packages/sdk` — curated public package surface
- `packages/control-api` — REST, SSE, webhook gateway, and HTTP MCP hosting
- `packages/runtime-adapter-core` — reusable dispatch contracts and generic transports
- `packages/adapter-claude-code` — Claude Code-specific execution adapter
- `packages/adapter-cursor-cloud` — Cursor Cloud-style execution adapter
- `packages/mcp-server` — stdio + HTTP MCP transport and tool registration
- `packages/testkit` — contract fixtures and schema validation helpers
- `packages/search-qmd-adapter` — search compatibility seam
- `packages/obsidian-integration` — editor-facing projections and exports
- `packages/skills` — package-level skill distribution surface

Package ownership and layering are documented in `docs/PACKAGE_BOUNDARIES.md`.

Migration notes: see `docs/MIGRATION.md`.
Live workspace repair runbook: see `docs/INVARIANT_REPAIR_PLAYBOOK.md`.
Realtime control-api SSE contract: see `docs/SSE_EVENTS.md`.

### Reliability and autonomy hardening

Recent hardening focused on making unattended operation safer rather than just
adding more commands:

- dispatch runs now maintain leases while executing and propagate timeout/cancel
  intent into adapter execution contracts
- autonomy cycles now repair dispatch state, reconcile expired leases, recover
  thread claim/reference drift, and run mission orchestration passes as part of
  the same control loop
- trigger actions can now express composable boolean conditions (`all` / `any`
  / `not`) and route risky `shell` / `update-primitive` actions through safety
  rails
- MCP now exposes trigger create/update/delete/fire tools in addition to the
  trigger engine cycle surface

### Development workflow (contributors)

```bash
pnpm install
pnpm run ci
```

The default `pnpm run test` script now uses `scripts/run-tests.mjs`, a hardened
Vitest wrapper that enforces deterministic process exit in CI (especially on
Windows where lingering `esbuild` children can keep `vitest run` alive after
all test files report complete).

- `pnpm run test`: hardened runner (recommended for CI/local reliability)
- `pnpm run test:vitest`: raw Vitest invocation (useful for debugging Vitest itself)

Optional tuning knobs:

- `WORKGRAPH_TEST_EXIT_GRACE_MS`: grace period after all file results are
  observed before forced process-tree cleanup (default `15000`)
- `WORKGRAPH_TEST_MAX_RUNTIME_MS`: hard timeout for the full run (default
  `1200000`)

### Demo vault generator

Generate the large Obsidian demo workspace used for stress-testing:

```bash
pnpm run demo:workspace
pnpm run demo:obsidian-setup
```

Runbook: `docs/OBSIDIAN_DEMO.md`.

### Space-scoped scheduling

```bash
workgraph thread create "Implement auth middleware" \
  --goal "Protect private routes" \
  --space spaces/backend.md \
  --actor agent-api \
  --json

workgraph thread list --space spaces/backend --ready --json
workgraph thread next --space spaces/backend --claim --actor agent-api --json
```

### Auto-generate `.base` files from primitive registry

```bash
# Sync .workgraph/primitive-registry.yaml
workgraph bases sync-registry --json

# Generate canonical primitive .base files
workgraph bases generate --json

# Include non-canonical (agent-defined) primitives
workgraph bases generate --all --refresh-registry --json
```

### Graph intelligence workflows

```bash
# Build/refresh graph index first (optional but useful)
workgraph graph index --json

# Multi-hop neighborhood around a primitive slug/path
workgraph graph neighborhood ship-feature --depth 2 --json

# Reverse-link blast radius (what references this primitive)
workgraph graph impact ship-feature --json

# Auto-assemble markdown context bundle within token budget (chars/4)
workgraph graph context ship-feature --budget 2000 --json

# Inspect typed relationship edges for one primitive
workgraph graph edges ship-feature --json

# Export a markdown subgraph for handoff/sharing
workgraph graph export ship-feature --depth 2 --format md --json
```

### Ledger query, blame, and tamper detection

```bash
workgraph ledger query --actor agent-worker --op claim --json
workgraph ledger blame threads/auth.md --json
workgraph ledger verify --strict --json
```

### Native skill lifecycle (shared vault / Tailscale)

```bash
# with shared vault env (e.g. tailscale-mounted path)
export WORKGRAPH_SHARED_VAULT=/mnt/tailscale/company-workgraph

workgraph skill write "workgraph-manual" \
  --body-file ./skills/workgraph-manual.md \
  --owner agent-architect \
  --actor agent-architect \
  --json

workgraph skill propose workgraph-manual --actor agent-reviewer --space spaces/platform --json
workgraph skill promote workgraph-manual --actor agent-lead --json
workgraph skill load workgraph-manual --json
workgraph skill list --updated-since 2026-02-27T00:00:00.000Z --json
workgraph skill history workgraph-manual --limit 10 --json
workgraph skill diff workgraph-manual --json
```

### Optional Clawdapus integration

List supported optional integrations:

```bash
workgraph integration list --json
```

Install by integration ID (extensible pattern for future integrations):

```bash
workgraph integration install clawdapus \
  --actor agent-architect \
  --json
```

Refresh from upstream later (or use the `integration clawdapus` alias):

```bash
workgraph integration install clawdapus --force --actor agent-architect --json
```

## Legacy memory stacks vs Workgraph primitives

`@versatly/workgraph` is **execution coordination only**.

- Use it for: ownership, decomposition, dependency management, typed coordination primitives.
- Do not use it for: long-term memory categories (`decisions/`, `people/`, `projects/` memory workflows), qmd semantic retrieval pipelines, observer/reflector memory compression.

This split keeps the workgraph package focused, portable, and shell-agent-native.

## Migrating from mixed memory/workgraph vaults

1. Initialize a clean workgraph workspace:
   ```bash
   workgraph init ./coordination-space --json
   ```
2. Recreate only coordination entities as workgraph primitives (`thread`, `space`, custom types).
3. Move or archive memory-specific folders outside the coordination workspace.
4. Generate a control plane note for humans/agents:
   ```bash
   workgraph command-center --output "ops/Command Center.md" --json
   ```

## Programmatic API

```ts
import { registry, thread, store, ledger, workspace } from '@versatly/workgraph';

workspace.initWorkspace('/tmp/wg');

registry.defineType('/tmp/wg', 'milestone', 'Release checkpoint', {
  thread_refs: { type: 'list', default: [] },
  target_date: { type: 'date' },
}, 'agent-architect');

const t = thread.createThread('/tmp/wg', 'Build Auth', 'JWT and refresh flow', 'agent-lead');
thread.claim('/tmp/wg', t.path, 'agent-worker');
thread.done('/tmp/wg', t.path, 'agent-worker', 'Shipped');
```

## Publish (package-only)

From this directory:

```bash
pnpm run ci
pnpm publish --access public
```

## Skill guide

See `SKILL.md` for the full operational playbook optimized for autonomous agents (including pi-mono compatibility guidance).
