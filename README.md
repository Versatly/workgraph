# @clawvault/workgraph

Agent-first workgraph workspace for multi-agent collaboration.

`@clawvault/workgraph` is the coordination core extracted from ClawVault. It focuses only on:

- Dynamic primitive registry (`thread`, `space`, `decision`, `lesson`, `fact`, `agent`, plus custom types)
- Append-only event ledger (`.clawvault/ledger.jsonl`)
- Ledger claim index (`.clawvault/ledger-index.json`) for fast ownership queries
- Tamper-evident ledger hash-chain (`.clawvault/ledger-chain.json`)
- Markdown-native primitive store
- Thread lifecycle coordination (claim/release/block/unblock/done/decompose)
- Space-scoped thread scheduling (`--space`)
- Generated markdown command center (`workgraph command-center`)
- Native skill primitive lifecycle (`workgraph skill write/load/propose/promote`)
- Primitive-registry manifest + auto-generated `.base` files
- JSON-friendly CLI for agent orchestration

No memory-category scaffolding, no qmd dependency, no observational-memory pipeline.

## Install

```bash
npm install @clawvault/workgraph
```

Or global CLI:

```bash
npm install -g @clawvault/workgraph
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
workgraph ledger show --count 20 --json
workgraph command-center --output "ops/Command Center.md" --json
workgraph bases generate --refresh-registry --json
```

### JSON contract

All commands support `--json` and emit:

- Success: `{ "ok": true, "data": ... }`
- Failure: `{ "ok": false, "error": "..." }` (non-zero exit)

This is intended for robust parsing by autonomous agents.

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
# Sync .clawvault/primitive-registry.yaml
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
```

## ClawVault memory vs Workgraph primitives (split clarification)

`@clawvault/workgraph` is **execution coordination only**.

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
import { registry, thread, store, ledger, workspace } from '@clawvault/workgraph';

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
