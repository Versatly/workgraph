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
- Multi-filter primitive query (`workgraph query ...`)
- Core + QMD-compatible keyword search (`workgraph search ...`)
- Obsidian Kanban board generation/sync (`workgraph board generate|sync`)
- Wiki-link graph indexing and hygiene reports (`workgraph graph index|hygiene`)
- Policy party registry and sensitive transition gates
- Programmatic dispatch contract (`workgraph dispatch ...`) with explicit status transitions
- Trigger dispatch bridge (`workgraph trigger fire ...`) with idempotency keying
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
workgraph thread create "Ship command center" \
  --description "Alias for --goal also supported" \
  --actor agent-lead \
  --json

workgraph thread next --claim --actor agent-worker --json
workgraph thread heartbeat --actor agent-worker --ttl-minutes 30 --json
workgraph thread leases --json
workgraph thread reap-stale --actor agent-ops --json
workgraph status --json
workgraph brief --actor agent-worker --json
workgraph query --type thread --status open --limit 10 --json
workgraph search "auth" --mode auto --json
workgraph checkpoint "Completed API layer" --next "implement tests" --actor agent-worker --json
workgraph thread reopen threads/auth.md --actor agent-worker --reason "follow-up regression" --json
workgraph board generate --output "ops/Workgraph Board.md" --json
workgraph graph hygiene --json
workgraph graph neighbors context-nodes/context-node-1 --json
workgraph dispatch create "Review blockers" --actor agent-lead --json
workgraph primitive schema thread --json
workgraph dispatch mark run_123 --status succeeded --output "Review complete" --actor agent-lead --json
workgraph dispatch create-execute "Close all ready threads in platform space" \
  --actor agent-lead \
  --adapter claude-code \
  --idempotency-key "coord-001" \
  --agents agent-a,agent-b,agent-c \
  --space spaces/platform \
  --json
workgraph dispatch adapters --json
workgraph trigger fire triggers/escalate-blocked.md --event-key "thread-blocked-001" --actor agent-lead --json
workgraph trigger engine run --actor agent-lead --watch --poll-ms 2000 --max-cycles 50 --json
workgraph autonomy run --actor agent-lead --agents agent-a,agent-b --watch --poll-ms 2000 --max-cycles 100 --json
workgraph autonomy daemon start --actor agent-lead --agents agent-a,agent-b --poll-ms 2000 --json
workgraph autonomy daemon status --json
workgraph autonomy daemon stop --json
workgraph onboarding update onboarding/onboarding-for-agent-architect.md --status paused --actor agent-lead --json
workgraph mcp serve -w /path/to/workspace --actor agent-ops --read-only
workgraph mcp serve-http -w /path/to/workspace --host 0.0.0.0 --port 8787 --bearer-token-env WORKGRAPH_MCP_TOKEN
workgraph ledger show --count 20 --json
workgraph ledger reconcile --json
workgraph command-center --output "ops/Command Center.md" --json
workgraph bases generate --refresh-registry --json
workgraph thread create "safe-op" -w /path/to/workspace --goal "preview mutation" --dry-run --json
```

### JSON contract

All commands support `--json` and emit:

- Success: `{ "ok": true, "data": ... }`
- Failure: `{ "ok": false, "error": "..." }` (non-zero exit)

This is intended for robust parsing by autonomous agents.

### Monorepo layout (MVP)

The repository is now organized as a workspaces monorepo while preserving the
published `@versatly/workgraph` package compatibility surface.

Key workspace packages:

- `packages/kernel`
- `packages/cli`
- `packages/sdk`
- `packages/control-api`
- `packages/runtime-adapter-core`
- `packages/adapter-cursor-cloud`
- `packages/policy`
- `packages/testkit`
- `packages/search-qmd-adapter`
- `packages/obsidian-integration`
- `packages/skills`

Migration notes: see `docs/MIGRATION.md`.

### Demo vault generator

Generate the large Obsidian demo workspace used for stress-testing:

```bash
npm run demo:workspace
npm run demo:obsidian-setup
```

Runbook: `docs/OBSIDIAN_DEMO.md`.

### One-command product demo

Replay end-to-end autonomy + trigger + MCP HTTP + adapter validation:

```bash
npm run build
node scripts/product-demo.mjs --log /tmp/workgraph-product-demo.log
```

### Claude Code adapter template

Set a command template for the `claude-code` adapter:

```bash
export WORKGRAPH_CLAUDE_COMMAND_TEMPLATE='claude -p {prompt_shell}'
workgraph dispatch create-execute "Plan next migration" \
  --adapter claude-code \
  --actor agent-lead \
  --json
```

Template tokens: `{workspace}`, `{run_id}`, `{actor}`, `{objective}`, `{prompt}`, `{prompt_shell}`.

### MCP over Tailnet / third-party clients

Use Streamable HTTP mode for remote MCP clients over Tailscale/tailnet:

```bash
export WORKGRAPH_MCP_TOKEN="replace-with-strong-token"
workgraph mcp serve-http \
  -w /srv/workgraph \
  --host 0.0.0.0 \
  --port 8787 \
  --allowed-hosts workgraph.tailnet.internal,127.0.0.1 \
  --bearer-token-env WORKGRAPH_MCP_TOKEN
```

Then connect third-party MCP clients to:

- Endpoint: `http://<tailnet-host>:8787/mcp`
- Auth: `Authorization: Bearer <WORKGRAPH_MCP_TOKEN>`

This keeps write tools policy-scoped while exposing read/write MCP operations to remote systems.

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
npm run ci
npm publish --access public
```

## Skill guide

See `SKILL.md` for the full operational playbook optimized for autonomous agents (including pi-mono compatibility guidance).
