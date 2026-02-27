# ContextHub WorkGraph Monorepo PRD

Date: 2026-02-27
Status: Draft v1 (execution plan)
Source vision: `new-contextgraph-monorepo.md`

## 1) Objective

Build a new standalone `contexthub-workgraph` monorepo that:

- closes current critical gaps (query/orientation/policy gates/dispatch)
- stays agent-runtime agnostic
- keeps Obsidian-native markdown workflows intact
- does not break the already published `workgraph` npm package in the migration window
- delivers an agent-native CLI UX that is fast, intuitive, and composable

## 2) Non-Goals (first path)

- no dual MCP architecture
- no MCP-first implementation
- no semantic search or observer pipeline in core
- no forced hosted-only mode

## 3) Critical Gaps to Close

1. Query and orientation gap:
   - missing `query` (multi-filter), `status/brief`, `search`, `checkpoint`
2. Schema integrity gap:
   - enum/ref/template constraints not fully enforced
3. Governance gap:
   - sensitive primitives lack enforceable promotion gates
4. Runtime dispatch gap:
   - no unified programmatic background-agent dispatch contract
5. Legacy coupling gap:
   - namespace/env coupling to old clawvault paths and aliases

## 3b) Coverage of `old-vs-new-workgraph-comparison.md`

This PRD now explicitly covers all major findings, split by phase:

- Phase 1 (must close now):
  - primitive query/list/update from CLI+SDK
  - enum/ref/template enforcement
  - orientation commands (`status/brief`, `checkpoint`, optional `intake`)
  - keyword search
  - board generation command
- Phase 2-3 (must close before autonomy scale):
  - promotion/policy gates
  - trigger and run lifecycle
  - onboarding primitive/state model
- Later/plugin track (not core-first):
  - semantic search (`vsearch`)
  - observer/session compression
  - wiki-link graph indexing
  - advanced presence/heartbeat UX

Everything above is tracked as scoped work, not ignored gaps.

## 4) Must-Have Principles

- CLI-first, agent-native developer experience
- markdown/frontmatter remain canonical in local-first mode
- party-registration + policy-driven permissions (not human-only assumptions)
- one kernel contract, thin adapters
- compatibility before cleanup for published package users

## 4b) Non-Negotiables (Requested)

1. Wiki-link graph indexing is default:
   - automatic indexing of `[[links]]`, backlinks, and orphans
   - graph view quality is a first-class requirement, not an optional plugin
2. Search is fully working:
   - robust keyword search in core
   - QMD-compatible adapter path for hybrid/semantic search
   - commands work with and without QMD installed (graceful fallback)
3. Obsidian board integration is automatic:
   - board generation emits Obsidian Kanban plugin-compatible markdown
   - sync/update flow is native (`board sync`, optional watch mode)
4. Obsidian integration strategy includes both:
   - latest Obsidian CLI compatibility
   - optional Obsidian plugin for richer workspace automation
5. Agent onboarding/init is first-class:
   - setup commands guide agents to configure workspace, policies, and views
6. Skill model is folder-native:
   - multi-file/multi-folder skills (not single file only), with best-practice structure
7. CLI quality bar:
   - commands optimized for agents (`--json`, deterministic output, clear errors, composable flows)

## 5) Monorepo Scope (Phase 1-2)

Create these packages first:

- `packages/kernel`
- `packages/cli`
- `packages/sdk`
- `packages/control-api`
- `packages/runtime-adapter-core`
- `packages/adapter-cursor-cloud` (or `adapter-codex`, pick one first)
- `packages/policy`
- `packages/testkit`
- `packages/search-qmd-adapter`
- `packages/obsidian-integration`
- `packages/skills`

Defer to later phase:

- `packages/mcp-server`
- `apps/web-control-plane`

## 6) Unknowns to Resolve (Agents Should Focus Here)

1. Policy contract:
   - exact shape for role/capability checks per transition
   - quorum and delegated approval semantics
2. Dispatch contract:
   - minimum fields for create/status/followup/stop/logs
   - idempotency and retry guarantees
3. Primitive promotion model:
   - gated state machine per sensitive primitive (`decision`, `policy`, `incident`, `trigger`)
4. Compatibility envelope:
   - which old CLI flags/JSON outputs are frozen until major version
5. Storage mode boundary:
   - local markdown truth vs gateway write authority in distributed mode
6. Skill distribution contract:
   - git-first vs snapshot fallback semantics
   - conflict handling and dependency resolution behavior
7. Obsidian board compatibility details:
   - canonical markdown generation rules for Obsidian Kanban plugin sync
8. Obsidian CLI constraints:
   - feature detection and fallback behavior when CLI features differ by version/license

## 7) Work Plan

### Phase 0 - Contract Lock

Deliverables:

- `schemas/primitive.schema.json`
- `schemas/query.schema.json`
- `schemas/run.schema.json`
- `schemas/policy.schema.json`
- `schemas/dispatch.schema.json`
- contract tests in `packages/testkit`

Exit:

- versioned schemas + conformance tests passing

### Phase 1 - Kernel + CLI Gap Closure

Deliverables:

- query/list/update primitives in CLI and SDK
- `brief` command (situational lens summary)
- `board` command (kanban/ops board generation)
- `checkpoint` command
- optional `intake` command
- keyword `search` command
- enum/ref/template enforcement in kernel validation
- default wiki-link graph indexing + query endpoints
- graph hygiene reports (`orphans`, `broken-links`, `highly-connected hubs`) for Obsidian graph quality
- QMD compatibility layer for enhanced search mode (fallback to core search)
- `init`/`onboard` agent-first setup flow (workspace customization included)

Exit:

- agent can orient, execute, and hand off without custom scripts

### Phase 2 - Policy Gates

Deliverables:

- party registry + role/capability model
- promotion gate engine
- transition guards on sensitive primitives
- audit entries for all approval/promotion edges
- onboarding primitive + lifecycle transitions
- Obsidian integration package:
  - board auto-sync helpers
  - graph/index health checks
  - optional plugin integration hooks

Exit:

- protected transitions cannot bypass policy from any interface

### Phase 3 - Runtime Dispatch

Deliverables:

- `dispatch.*` control API
- one production adapter (Cursor Cloud Agents or Codex first)
- trigger engine calls dispatch with idempotency keys
- run primitive + status transitions (`queued/running/succeeded/failed/cancelled`)

Exit:

- background agent run can be triggered programmatically and traced end-to-end

### Phase 4 - MCP Integration (after core is stable)

Deliverables:

- single MCP server package
- read-first context tools
- selected write tools behind policy scopes

Exit:

- external tools can consume context graph safely without bypassing policy

## 7b) Native Skill Distribution Workstream (Thought Experiment)

Goal: org-private skill distribution using shared workgraph storage (Tailscale/NFS/SMB), no package manager required.

Required behavior:

- filesystem-native distribution:
  - shared vault is the skill registry of record
- commands:
  - `skill write`, `skill load`, `skill list`, `skill history`, `skill diff`, `skill propose`, `skill promote`
  - `skill list --updated-since <time>`
- governance:
  - policy/party-based permissions for write/propose/promote
- versioning:
  - git-backed history preferred
  - snapshot fallback when git unavailable
- auditability:
  - ledger events for create/update/propose/promote with version metadata
- Obsidian-native visibility:
  - skill markdown remains human-browsable/editable
- folder-native skill structure:
  - each skill supports `SKILL.md` + optional `scripts/`, `examples/`, `tests/`, `assets/`
  - manifest metadata references multi-file components cleanly
- reliability:
  - conflict detection for concurrent edits
  - declared skill dependencies in metadata
  - optional validation/test hook before promote

Reference folder model (configurable):

- `skills/core`, `skills/tools`, `skills/workflows`, `skills/clients`, `skills/internal`, `skills/experimental`

## 8) Package Compatibility Strategy (Do Not Break npm Users)

- keep current published package interface stable during migration
- provide compatibility wrapper in new repo
- run parity tests against legacy command behavior and JSON outputs
- only remove compatibility in a planned major release with migration docs/tooling

## 9) Acceptance Criteria

- monorepo builds and tests green
- old package compatibility tests pass
- orientation loop (`brief -> next/claim -> done/checkpoint`) works from CLI
- policy gates block unauthorized promotion transitions
- one adapter executes background runs programmatically with full audit trail
- native skill distribution flow works end-to-end in shared-vault mode
- wiki-link graph index is default-on and queryable
- graph hygiene report is generated and actionable from CLI
- search works end-to-end in core mode and QMD-compatible mode
- board sync produces Obsidian Kanban-compatible markdown automatically
- agent onboarding/init can configure a usable, customized workspace in one guided flow
- CLI DX tests pass (deterministic JSON, stable errors, composable command chains)

## 10) Agent Execution Guidance (Concise)

When agents implement this PRD, prioritize:

1. contracts and tests before feature breadth
2. kernel correctness before integrations
3. one adapter done well before many adapters
4. no runtime-specific code inside kernel

If a change does not close a listed critical gap or unknown, defer it.
