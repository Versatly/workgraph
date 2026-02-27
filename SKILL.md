---
name: workgraph
version: "0.1.0"
description: Agent-first multi-agent coordination skill for markdown-native workgraph workspaces. Use when coordinating threads, ownership, dependencies, and custom primitive schemas across multiple agents. Do not use for general long-term memory capture; this package intentionally excludes ClawVault memory scaffolding.
author: Versatly
source: https://github.com/Versatly/clawvault/tree/main/packages/workgraph
user-invocable: true
---

# Workgraph Skill — Multi-Agent Coordination

This skill defines how autonomous agents should operate a shared workgraph workspace safely and predictably.

## Purpose

Use workgraph to coordinate execution, not to hoard generic memory.

- **Good fit:** ownership, decomposition, dependency scheduling, execution audit trail.
- **Not a fit:** journaling, free-form personal memory, semantic search infrastructure.

## Workspace Model

A workgraph workspace contains:

- `.workgraph.json` — workspace identity and mode.
- `.clawvault/registry.json` — primitive type definitions.
- `.clawvault/ledger.jsonl` — append-only event stream.
- `.clawvault/ledger-index.json` — derived claim snapshot for fast ownership checks.
- `.clawvault/ledger-chain.json` — tamper-evident hash-chain state.
- `.clawvault/primitive-registry.yaml` — canonical primitive registry manifest.
- `.clawvault/bases/*.base` — generated Obsidian Bases files.
- Primitive directories (e.g. `threads/`, `spaces/`, `agents/`, custom directories).

Initialize once:

```bash
workgraph init /path/to/workspace --json
```

## Core Operational Contract

### 1) Every mutating action must be attributable

Always pass `--actor <agent-name>` on thread/primitive mutation commands.

### 2) Always parse machine output

Use `--json` for all automation.

Success payload:

```json
{ "ok": true, "data": { ... } }
```

Failure payload (non-zero exit):

```json
{ "ok": false, "error": "..." }
```

### 3) Never assume a thread is claimable

Call `thread next --json` or `thread list --ready --json`, then claim.

### 4) Never mutate without ledger awareness

Before major orchestration steps, inspect:

```bash
workgraph ledger claims --json
workgraph ledger show --count 30 --json
workgraph ledger verify --json
```

## Standard Agent Loop

This loop is the canonical multi-agent behavior:

1. **Sense**
   - `workgraph thread next --json`
   - `workgraph ledger claims --json`
2. **Claim**
   - `workgraph thread claim <path> --actor <agent> --json`
3. **Execute**
   - Perform implementation work in repo.
4. **Publish state**
   - `workgraph thread done <path> --actor <agent> --output "<result>" --json`
   - OR `workgraph thread block <path> --blocked-by <dep> --reason "<why>" --actor <agent> --json`
5. **Continue**
   - Return to step 1.

## Dependency and Readiness Semantics

`thread next` and `thread list --ready` treat a thread as ready only when:

- status is `open`
- all dependency refs point to threads whose status is `done`
- external dependencies (prefix `external/`) are considered not ready

This allows deterministic autonomous scheduling without hidden state.

## Primitive Design Rules

When creating custom types:

1. Add only fields needed by a specific recurring coordination pattern.
2. Use `ref` or `list` fields for links to other primitives.
3. Keep state-machine-like fields explicit (`status`, `phase`, `go_no_go`, etc).
4. Define type once; instantiate many times.

Example:

```bash
workgraph primitive define command-center \
  --description "Operational cockpit for active agents" \
  --fields owner:string \
  --fields panel_refs:list \
  --fields active_agents:list \
  --dir command-centers \
  --actor agent-architect \
  --json
```

## Advanced Patterns

### Pattern: Decompose before contention

If several agents are idle and one large thread exists:

```bash
workgraph thread decompose threads/large-initiative.md \
  --sub "Schema|Model storage and indexes" \
  --sub "Execution|Implement worker pipeline" \
  --sub "Validation|Run multi-agent E2E checks" \
  --actor agent-lead \
  --json
```

### Pattern: Pull-based agent scheduling

Each worker repeatedly executes:

```bash
workgraph thread next --claim --actor agent-worker-X --json
```

No centralized scheduler is required.

### Pattern: Space-scoped queues

Teams can isolate execution lanes with `space`:

```bash
workgraph thread list --space spaces/backend --ready --json
workgraph thread next --space spaces/backend --claim --actor agent-backend-1 --json
```

### Pattern: Audit-first incident review

For postmortems:

```bash
workgraph ledger history threads/critical-thread.md --json
workgraph ledger show --count 200 --json
workgraph ledger blame threads/critical-thread.md --json
```

## pi-mono Compatibility Profile

This package is designed for shell-driven agents like `pi-mono`.

### Why it works

- CLI has deterministic JSON envelopes.
- Errors are machine-readable.
- No GUI dependency.
- No qmd dependency.

### Recommended command wrapper

For pi-mono or similar agents, always run:

```bash
workgraph <command...> --json
```

Then parse:

- `ok === true` -> continue
- `ok === false` -> route to retry/escalation path

### Suggested pi-mono orchestration sequence

1. `workgraph thread next --claim --actor pi-mono-worker --json`
2. if no thread: sleep/backoff
3. implement task
4. `workgraph thread done <path> --actor pi-mono-worker --output "<summary>" --json`
5. repeat

### pi-mono skill distribution flow

```bash
workgraph skill write "workgraph-manual" --body-file ./skills/workgraph-manual.md --actor pi-mono-curator --json
workgraph skill propose workgraph-manual --actor pi-mono-reviewer --space spaces/platform --json
workgraph skill promote workgraph-manual --actor pi-mono-lead --json
```

### Backoff recommendations

- Empty queue: exponential backoff (`2s`, `4s`, `8s`, `16s`, cap `60s`)
- Claim conflict: immediate refresh via `thread next --json`

## Safety and Concurrency Guardrails

1. Never force-claim an active thread.
2. Only owner can release/done owner-bound threads.
3. Use `block` when waiting on external or unresolved dependencies.
4. Keep `output` concise but sufficient for downstream agents.
5. Keep parent/child decomposition coherent; workers should usually claim leaf threads first.

## Exit Criteria for Agent Tasks

A task is complete only when:

- Thread transitioned to `done`
- Output summary recorded
- Any new primitives created are linked/referenced by path
- Ledger confirms expected final operations

## Recommended Team Conventions

- Agent names: `role-instance` (`agent-worker-1`, `agent-reviewer-a`)
- Thread titles: imperative and specific (`Implement token refresh API`)
- Dependency refs: workspace-relative paths (`threads/schema.md`)
- Use `external/<system>` for dependencies outside workgraph

## Quick Command Reference

```bash
# init
workgraph init /path/to/ws --json

# threads
workgraph thread create "Title" --goal "Outcome" --actor me --json
workgraph thread list --json
workgraph thread list --ready --json
workgraph thread next --claim --actor me --json
workgraph thread claim threads/x.md --actor me --json
workgraph thread block threads/x.md --blocked-by external/api --reason "Waiting token" --actor me --json
workgraph thread unblock threads/x.md --actor lead --json
workgraph thread done threads/x.md --actor me --output "Shipped" --json

# primitives
workgraph primitive define type-name --description "..." --fields key:string --actor me --json
workgraph primitive create type-name "Instance Title" --set key=value --actor me --json
workgraph primitive list --json

# bases
workgraph bases sync-registry --json
workgraph bases generate --json
workgraph bases generate --all --refresh-registry --json

# ledger
workgraph ledger show --count 30 --json
workgraph ledger claims --json
workgraph ledger history threads/x.md --json
workgraph ledger query --actor me --op claim --json
workgraph ledger blame threads/x.md --json
workgraph ledger verify --strict --json
workgraph ledger seal --json

# command center
workgraph command-center --output "ops/Command Center.md" --json

# skills
workgraph skill write "name" --body-file ./skills/name.md --actor me --json
workgraph skill load name --json
workgraph skill propose name --actor me --json
workgraph skill promote name --actor me --json
```

## Anti-Patterns

- Using workgraph as a dumping ground for unstructured notes.
- Skipping `--actor` on mutating operations.
- Parsing text output in automation instead of `--json`.
- Treating `open` as implicitly claimable without readiness checks.

## Migration Guidance (from memory-heavy flows)

If your agents currently use broad memory categories for execution coordination:

1. Move active execution tasks into `thread` primitives.
2. Store governance facts as `decision`/`fact` primitives if needed.
3. Keep long-term memory in a separate system/package.
4. Use workgraph only for active multi-agent execution topology.

## Split Clarification

- `clawvault` package: memory + retrieval + broader vault lifecycle.
- `@clawvault/workgraph` package: coordination substrate only.

Treat this package as the authoritative runtime for multi-agent primitives and claims, not as a memory taxonomy tool.
