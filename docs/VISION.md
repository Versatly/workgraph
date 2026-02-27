# WorkGraph Vision

Date: 2026-02-27
Status: Vision v2 (strategy only)

Implementation companion: `new-contextgraph-monorepo-prd.md`

## 1) The Core Idea

WorkGraph is not an "agent memory app." It is the runtime-agnostic context graph substrate for AI-native companies.

The graph should answer, in real time:

- What exists (entities, work, decisions, risks, policies)?
- What is happening now (claims, runs, blockers, incidents)?
- What should happen next (priority-ordered actions and automations)?
- Why should we trust it (provenance, policy, audit chain)?

This is the missing layer between:

- agent runtimes (Claude Code, Codex CLI, OpenCode, OpenClaw, Hermes, Cursor, etc.)
- and company operations (projects, clients, roles, approvals, deployment, incident response).

## 2) Strategic Positioning

WorkGraph today is strong at coordination. To become the company context graph, it must add first-class situational awareness and runtime orchestration.

Positioning statement:

"WorkGraph is the graph-native operating system for AI companies: a shared, verifiable context layer that any agent runtime can read from and execute against."

## 3) Deep Focus: P0 Situational Awareness Gap

Current gap:

- excellent mutation primitives (create/claim/done/ledger)
- weak orientation primitives (status/brief/query/search/checkpoint)

Without orientation, agents are productive only locally; they cannot become reliable organizational operators.

### P0 Response: Context Lenses

Introduce "Context Lenses" as deterministic, queryable state products:

- `lens://my-work` -> "what I own + what is blocked + what is due"
- `lens://team-risk` -> urgent blockers, stale claims, failed runs, policy violations
- `lens://customer-health` -> active customer threads, incidents, SLA risk
- `lens://exec-brief` -> top priorities, momentum, risk, decisions since yesterday

Each lens has:

- input contract (primitives + filters)
- computation contract (sorting, scoring, grouping)
- output contract (JSON + markdown summary)

This gives runtime-agnostic situational awareness with no model-specific prompt hacks.

### Orientation Commands (must ship early)

- `workgraph status`
- `workgraph brief --actor <id>`
- `workgraph query <type> --filter ...` (multi-filter)
- `workgraph search "<text>"`
- `workgraph checkpoint "<summary>" --next ... --blocked ...`
- `workgraph intake "<observation>"` (optional)

These are not "nice to have." They are the minimum viable orientation loop for autonomous operations.
Note: `intake` is optional and should not become memory bloat.

## 4) Competitive Runtime Research and Lessons

Research highlights:

1. Claude Code:
   - strong MCP support (remote HTTP, stdio)
   - strong lifecycle hooks (`PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`)
   - lesson: hook-driven automation and MCP-first extension are now baseline

2. Codex CLI:
   - rich sandbox/approval policy controls
   - MCP config in `config.toml`
   - can run as MCP server (`codex mcp-server`) and be orchestrated by Agents SDK
   - lesson: runtime can be both client and tool-provider; embrace bidirectional composition

3. OpenCode:
   - non-interactive run mode, headless server, agent configs, MCP auth/debug
   - per-agent tool enable/disable patterns
   - lesson: policy-scoped tooling and server mode matter for real operations

4. OpenClaw:
   - local-first gateway control plane
   - multi-agent routing + sessions + cron + remote operation patterns
   - lesson: always-on gateway with clear operational runbook is a strategic advantage

5. Hermes Agent:
   - persistent memory + skills + scheduler + subagents + sandbox options
   - lesson: long-lived autonomy needs scheduling, skill accumulation, and isolation boundaries

Key market pattern:

- everyone is converging on MCP + tools + sessions
- almost nobody owns the shared company context graph as a first-class product

This is WorkGraph's opening.

## 5) Product Thesis: Primitive Kernel + Runtime Mesh

### Primitive Kernel (truth layer)

Keep and harden:

- typed primitive registry
- append-only ledger + hash-chain
- claims/ownership + thread lifecycle
- markdown-native storage (with optional server-backed persistence)

Add urgently:

- enum and ref integrity constraints
- template -> schema sync
- multi-field query and list/update primitives from CLI and API

### Runtime Mesh (execution layer)

Adapters for runtimes execute against graph truth:

- Claude Code adapter
- Codex adapter
- OpenCode adapter
- OpenClaw adapter
- Hermes adapter
- generic MCP adapter

Each adapter implements the same `RunContract`:

- requested objective
- required context lenses
- tools/policy envelope
- completion payload
- emitted run events to ledger

### Autonomy Loop (event layer)

Trigger engine subscribes to graph events and starts runs deterministically.

Example:

- event: `thread.blocked` with `priority in [urgent, high]`
- rule: create escalation thread + dispatch reviewer agent run + notify owner
- outputs: new primitives + run records + alerts + full provenance

## 6) Monorepo Blueprint (New Standalone Repo)

Repo: `workgraph`

```text
packages/
  kernel/                 # registry, store, ledger, thread, policy, query engine
  cli/                    # workgraph CLI (human + automation mode)
  sdk/                    # typed TS SDK (and language-neutral OpenAPI schema)
  mcp-server/             # MCP tools/resources over kernel services
  trigger-engine/         # event rules, scheduler, run dispatch
  runtime-adapter-core/   # adapter interface + shared lifecycle
  adapter-claude-code/
  adapter-codex/
  adapter-opencode/
  adapter-openclaw/
  adapter-hermes/
  cursor-integration/     # Cursor-specific UX helpers and command shims
  obsidian-integration/   # optional graph and base integrations
  web-control-plane/      # operator UI (status, runs, claims, incidents)
  policy/                 # policy DSL + enforcement modules
  testkit/                # fixtures, contract tests, runtime mocks
apps/
  gateway/                # always-on service exposing API/MCP/events
  worker/                 # trigger workers and scheduler runners
  smoke/                  # end-to-end scenario harness
docs/
  vision/
  architecture/
  operations/
```

## 7) Remove ClawVault Legacy Completely

Hard migration rules:

1. rename all state paths to `.workgraph/*` (drop `.clawvault/*`)
2. remove all `CLAWVAULT_*` env aliases from runtime behavior
3. keep a one-time migration command:
   - `workgraph migrate --from-clawvault`
4. fail fast on mixed namespaces after migration

Identity principle:

- compatibility is a migration feature
- not a permanent design constraint

## 8) Company Context Graph Primitive Set (v1)

Keep built-ins:

- `thread`, `space`, `decision`, `fact`, `agent`, `skill`

Add built-ins for company operations:

- `org` (company root context)
- `team`
- `role`
- `person` (human)
- `client`
- `onboarding` (entity activation lifecycle)
- `run` (execution instance with status, runtime, timings)
- `trigger` (event -> action contract)
- `incident`
- `policy`
- `checkpoint`

Design principle:

- keep primitives small and composable
- let users define higher-level domain types via extension

## 9) Plugin and Integration Strategy

### CLI-first, agent-native core

Build order is explicit:

- first path: `kernel + cli + sdk + control api`
- later path: MCP integration for external consumers and runtime interoperability

MCP is not the first delivery surface.

### Obsidian-native compatibility contract

Yes, this should remain native with Obsidian by design, not by adapter hacks.

Rules:

- markdown files remain first-class primitive instances (human-editable, git-friendly)
- frontmatter is the canonical schema envelope for primitive fields
- folder-per-type layout stays stable for Dataview/Bases compatibility
- generated operational files live under `.workgraph/generated/*` and can be mirrored into vault-visible docs when desired
- no mandatory hosted database for local-first mode; gateway mode is optional

Practical compatibility targets:

- Obsidian opens the workspace directly with no plugin required
- Dataview queries over primitive folders work out of the box
- `.base` generation remains supported for table/board-style views
- wiki-links (`[[...]]`) remain valid cross-primitive references

Design note:

- when server mode is enabled, the system still writes markdown projections so humans can inspect and edit the graph state in Obsidian

### Runtime-native plugin surfaces

- Claude Code: ship hook recipes (`PostToolUse` -> graph writebacks, `Stop` -> checkpoint)
- Codex: ship MCP profile templates + run policies
- OpenCode: ship opencode config snippets + per-agent tool profiles
- OpenClaw/Hermes: ship gateway bridge adapters for session/routing/cron federation
- Cursor: ship "WorkGraph Actions" package:
  - claim next thread
  - show brief summary
  - mark done with summary
  - open run trace

### Programmatic background-agent dispatch

Add a unified dispatch API so triggers can start background agents across runtimes:

- `dispatch.create` -> launch a run with `RunContract`
- `dispatch.status` -> poll run state
- `dispatch.followup` -> send continuation input
- `dispatch.stop` -> cancel run safely
- `dispatch.logs` -> stream execution output/events

Adapter mappings:

- Cursor Cloud Agents adapter: map `dispatch.*` to Cursor Cloud Agents API (`/v0/agents`, `/followup`, `/stop`, `/conversation`)
- Codex adapter: use `codex mcp-server` tool calls or CLI worker execution
- Claude Code adapter: use MCP + hooks for local/session automation; use background worker process for unattended runs
- OpenCode adapter: use `run`/`serve` interfaces for async execution
- OpenClaw/Hermes adapters: use gateway/session APIs for long-running agents

Important nuance:

- interactive Cursor-in-IDE agents and cloud agents are different surfaces
- v1 should rely on Cloud Agents API for programmatic background runs
- IDE plugin should focus on operator actions and context sync, not hidden local automation

## 10) Trigger Autonomy Loop (New Capability)

### Event pipeline

1. every mutation appends an immutable ledger event
2. trigger engine consumes events with cursor offsets
3. matching rules schedule actions with idempotency keys
4. actions call adapters and produce `run` primitives
5. run outcomes feed back into ledger and lenses

### Safety model

- idempotency keys for every trigger action
- dead-letter queue for failed trigger executions
- policy gates before run dispatch
- promotion gates for sensitive action classes
- replay + audit mode for incident review

## 10b) Promotion Gates and Party-Based Permissions

Gates are not "human-only." They are policy/party enforced.

- every actor (human or agent) is a registered party with roles/capabilities
- sensitive primitives (`decision`, `policy`, `incident`, high-impact `trigger`) use gated state transitions
- transitions require policy satisfaction (role, quorum, or explicit approver set), not just actor type
- default rule: agents can draft/propose; approval/activation depends on policy, not assumptions

Example transition:

- `decision`: `draft -> proposed -> approved -> active`
- policy decides who can move each edge

## 11) Multi-Computer + Tailscale + NAS Topology

Target architecture:

- one always-on WorkGraph Gateway (NAS or server)
- exposes:
  - MCP endpoint
  - REST/WS API
  - event stream
  - admin/control UI
- protected by Tailscale network + service auth tokens

Client pattern:

- each agent runtime connects to gateway over tailscale
- local cache/read replica optional for resilience
- writes go to gateway truth service (single writer per partition)

This avoids split-brain markdown edits across many machines while preserving markdown projections for human inspectability.

## 12) Phased Execution Plan

### Phase 0: Contract Lock (1 week)

- freeze primitive schema contract, query contract, run contract
- define lens output schemas
- define policy and auth model

Exit criteria:

- JSON contracts versioned and test fixtures published

### Phase 1: Kernel + Orientation (2-3 weeks)

- move core engine into `packages/kernel`
- ship `query/status/brief/intake/checkpoint/search`
- add enum/ref validation and template sync

Exit criteria:

- agents can self-orient and execute full daily loop without custom scripts

### Phase 2: Runtime Mesh + Dispatch (2-3 weeks)

- `packages/runtime-adapter-core`
- adapter-core + first two runtime adapters (Claude Code + Codex)
- Cursor Cloud Agents dispatch adapter

Exit criteria:

- same thread lifecycle can be executed by at least 3 runtimes via shared contracts

### Phase 3: Trigger Autonomy + Runs + MCP (3-4 weeks)

- trigger engine + scheduler + run primitive
- idempotency, retries, dead-letter, audit replay
- MCP server for context retrieval and selected controlled operations

Exit criteria:

- thread events can automatically dispatch runtime runs safely
- MCP clients can retrieve context graph views safely

### Phase 4: Distributed Control Plane (3-4 weeks)

- gateway service on NAS/server
- Tailscale secure federation
- web control plane for operators

Exit criteria:

- multiple agents on multiple machines collaborate on one shared truth with no manual sync hacks

## 13) What Makes This Unlike Existing Systems

Most systems are either:

- runtime-centric (great at one agent UX)
- memory-centric (great at retrieval but weak at orchestration)
- workflow-centric (great automations, weak shared semantic context)

WorkGraph combines:

- graph-native truth (primitives + immutable event chain)
- runtime-agnostic execution mesh (adapter protocol)
- deterministic orientation layer (context lenses)
- autonomous trigger-run loop with governance

This is an AI-native company operating system, not just another agent shell.

## 14) Success Metrics (North Star)

- time-to-orientation for any agent runtime < 5 seconds
- % of autonomous actions with full provenance > 99%
- stale-claim incident rate down week-over-week
- cross-runtime task completion success rate > 95%
- trigger idempotency failure rate < 0.1%

## 15) Elegance and Anti-Overengineering Guardrails

To keep this malleable and adaptive as the ecosystem changes:

- one stable kernel contract (`primitive`, `query`, `run`, `event`) and thin adapters
- no runtime-specific logic in kernel
- add features as plugins unless they are required by every deployment
- default to local-first markdown mode; gateway/distributed mode is additive
- every new subsystem must prove operational value with one concrete lens or automation outcome
- if a capability cannot be expressed as primitives + events + policies, do not merge it into core
- avoid parallel protocols that duplicate semantics (one dispatch contract, one policy contract)

What I would do in practice:

1. ship orientation primitives + schema integrity first
2. ship dispatch API + one production adapter (Cursor Cloud or Codex) before building many adapters
3. validate real autonomy loops in one team workspace
4. then add MCP as integration surface
5. then scale to multi-site gateway federation over Tailscale

This preserves power without complexity collapse.

## 16) Published Package Compatibility

Do not break the already published `workgraph` npm package.

Compatibility policy:

- keep existing CLI behavior stable for current commands during migration window
- maintain existing package exports and runtime contracts until explicit major release
- implement new monorepo with a compatibility wrapper package first
- only remove legacy compatibility in a planned major version with migration tooling

---

This vision intentionally optimizes for malleable primitives and extension by design: humans and agents should be able to create new organizational capabilities by composing primitives, lenses, and triggers, without forking the core system.