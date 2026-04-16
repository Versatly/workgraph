# @versatly/workgraph

`@versatly/workgraph` is a focused multi-agent coordination workspace built around four pillars:

1. **context graph**
2. **thread collaboration**
3. **MCP exposure**
4. **actor registration**

The codebase has been narrowed to favor a smaller, more coherent system over a broad control-plane product surface.

## What it does

- stores coordination primitives as markdown with frontmatter
- maintains an append-only ledger for thread and actor activity
- models collaboration through:
  - `thread`
  - `conversation`
  - `plan-step`
  - thread-scoped context entries
- exposes read/write/collaboration operations over MCP
- supports actor registration, registration requests/reviews, credentials, and presence heartbeats
- builds context graph views from registry-backed primitives and wiki-link graph analysis

## Workspace packages

- `packages/kernel` — context graph, thread collaboration, auth, and registration domain logic
- `packages/cli` — focused CLI over the retained kernel workflows
- `packages/mcp-server` — stdio + HTTP MCP server
- `packages/sdk` — curated public exports

## Install

```bash
npm install @versatly/workgraph
```

Global CLI:

```bash
npm install -g @versatly/workgraph
```

## Quick start

```bash
pnpm install
pnpm run build
```

Initialize a workspace:

```bash
workgraph init ./wg-space --json
```

Create and work a thread:

```bash
workgraph thread create "Ship collaboration flow" \
  --goal "Implement the retained MCP collaboration surface" \
  --actor agent-lead \
  --json

workgraph thread next --claim --actor agent-worker --json
workgraph thread done threads/ship-collaboration-flow.md \
  --actor agent-worker \
  --output "Completed https://github.com/Versatly/workgraph/pull/123" \
  --json
```

Explore the context graph:

```bash
workgraph graph index --json
workgraph graph neighborhood ship-collaboration-flow --depth 2 --json
workgraph graph context ship-collaboration-flow --budget 2000 --json
workgraph query --type thread --status open --json
workgraph search "registration" --json
```

Register and review actors:

```bash
workgraph agent request agent-1 \
  --role roles/contributor.md \
  --actor agent-1 \
  --json

workgraph agent review agent-registration-requests/agent-1-123.md \
  --decision approved \
  --actor admin-reviewer \
  --json

workgraph agent heartbeat agent-1 --status online --actor agent-1 --json
```

Run MCP:

```bash
workgraph mcp serve -w ./wg-space --actor agent-ops

workgraph serve -w ./wg-space --actor agent-ops --port 8787
```

## JSON contract

All CLI commands support `--json`:

- success: `{ "ok": true, "data": ... }`
- failure: `{ "ok": false, "error": "..." }`

This contract is intended for reliable automation.

## Programmatic API

```ts
import { registry, thread, workspace } from '@versatly/workgraph';

workspace.initWorkspace('/tmp/wg');

registry.defineType('/tmp/wg', 'note', 'Shared context note', {
  context_refs: { type: 'list', default: [] },
}, 'agent-architect');

const t = thread.createThread('/tmp/wg', 'Build auth', 'Ship actor registration flow', 'agent-lead');
thread.claim('/tmp/wg', t.path, 'agent-worker');
```

## Development

```bash
pnpm run typecheck
pnpm run test
pnpm run build
```

The repository uses the hardened `scripts/run-tests.mjs` wrapper for reliable Vitest exits.
