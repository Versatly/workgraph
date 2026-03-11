# Cursor Agent Prompt — WorkGraph Architecture Roadmap

This is the prompt to dispatch. Do not commit this file.

---

Build the five-phase architectural evolution of WorkGraph from a local coordination kernel into a cross-runtime, policy-governed, operator-visible company coordination fabric.

WorkGraph is a monorepo (~37K lines in packages/kernel, 89 test files, 446+ passing tests) that coordinates AI agent work through markdown primitives, a typed ledger, policy gates, triggers, missions, and runtime adapters. The current system works well for local single-runtime coordination. This work extends it to handle external runtimes, explicit event transport, federation, and real operator surfaces.

The five phases are ordered by dependency. Each phase builds on the previous. Do not skip phases or implement them out of order.

## Phase 1: External Run Broker

The run primitive (dispatch.ts, ~1900 lines) currently dispatches to runtime adapters (Cursor cloud, Claude Code, shell, HTTP webhook) but lacks durable correlation with external execution state. When the WorkGraph process restarts, in-flight runs lose their connection to whatever external job they dispatched.

Extend the run lifecycle so that:
- Each run stores provider-specific external identity (e.g., Cursor agent ID, GitHub Actions run ID, webhook delivery ID) in its frontmatter under an `external` field
- A reconciler (reconciler.ts exists, ~305 lines — extend it) can match inbound webhook events or polling results to existing runs by external ID
- Outbound dispatch is tracked durably: what was sent, when, whether it was acknowledged, retry count
- Run state transitions (dispatched → running → completed/failed/cancelled) are driven by reconciliation, not just adapter callbacks
- The Cursor cloud adapter (adapter-cursor-cloud.ts in kernel + packages/adapter-cursor-cloud) is the first production path — make it fully durable with external ID correlation, status polling, and cancellation

The dispatch-run-audit.ts and dispatch-run-evidence.ts files handle audit and evidence — extend these to record external correlation metadata in the audit trail.

Add tests that simulate: dispatch → process restart → reconcile from external state → correct run completion. This is the critical invariant.

## Phase 2: Event Transport Fabric

The ledger (ledger.ts, ~459 lines) is the append-only audit log. Triggers (trigger-engine.ts, ~1871 lines) fire on ledger events. But delivery is implicit — triggers fire side effects directly, with no durable outbox, no dead-letter, no replay.

Build an explicit event transport layer:
- `packages/kernel/src/transport/` directory with: outbox.ts (persistent outbound event queue), inbox.ts (persistent inbound event buffer), envelope.ts (typed event envelope contract), dead-letter.ts (failed delivery inspection and replay)
- Every trigger delivery, webhook dispatch, runtime bridge event, and future federation message goes through the outbox as a durable record before delivery is attempted
- Inbound webhook events (webhook-gateway.ts in control-api) land in the inbox with dedup (the LRU dedup from PR #43 stays, but inbox adds persistence for replay/inspection)
- Failed deliveries go to dead-letter with structured error context. Operators can inspect and replay via MCP tools
- The ledger remains the source of truth for what happened. Transport records govern delivery state (pending → delivered → failed → replayed)
- Add MCP tools: `wg_transport_outbox_list`, `wg_transport_inbox_list`, `wg_transport_dead_letter_list`, `wg_transport_replay`

All transport state lives in `.workgraph/transport/` as markdown files with YAML frontmatter, consistent with the rest of the system.

## Phase 3: Protocol-Aware Federation

Federation currently exists (federation.ts, ~596 lines) but assumes local mounted paths. Extend it:
- Add explicit workspace identity: each workspace gets a stable UUID, protocol version, capability set (what it can serve), and trust level
- Typed federated links: when a thread references a remote workspace's primitive, the link includes workspace ID, primitive type, primitive slug, and protocol version — not just a filesystem path
- Dereference semantics: resolving a federated ref first checks the remote workspace's capability set, then fetches through the appropriate transport (local path for now, HTTP/MCP endpoint stub for future)
- Read-only federation first: remote workspaces can be queried but not mutated. This is the only supported trust model in this phase
- Conflict/authority: if local and remote have the same primitive slug, local wins. If a federated query returns stale data, the staleness is surfaced in the result
- Version/capability negotiation: remote handshake returns protocol version + supported operations. Incompatible versions fail with clear error
- Add federation MCP tools: `wg_federation_status`, `wg_federation_resolve_ref`, `wg_federation_search`

Keep `.workgraph/federation.yaml` as the config surface. Extend it with identity, protocol, and capability fields.

## Phase 4: Runtime Composition Cleanup

Kernel currently has concrete adapter files (adapter-cursor-cloud.ts, adapter-claude-code.ts, adapter-shell-worker.ts, adapter-http-webhook.ts) alongside the abstract contracts (runtime-adapter-contracts.ts, runtime-adapter-registry.ts). packages/runtime-adapter-core has its own adapter-registry.ts and contracts.ts.

Clean this up:
- Kernel defines orchestration interfaces only — what a runtime adapter must implement (dispatch, poll, cancel, reconcile, health)
- Concrete adapter implementations move fully into their respective packages (packages/adapter-cursor-cloud, packages/adapter-claude-code, etc.) — no adapter business logic in kernel
- packages/runtime-adapter-core provides the shared registration, lifecycle, and transport contracts that all adapters implement
- Kernel's runtime-adapter-registry becomes a thin registry that accepts whatever adapters are composed in at startup, not a place that imports concrete adapters
- Adding a new runtime adapter = creating a new package that implements the contracts, registering it at composition time. Zero kernel changes required
- Preserve all existing test contracts — no adapter should change observable behavior, only where the code lives

## Phase 5: Projections and Operator Surface

The lens system (lens.ts, ~595 lines) and orientation/ directory provide read views. The web control plane exists (apps/web-control-plane). But operator visibility is still best-effort.

Make it first-class:
- Promote lens contracts from kernel into typed read-model interfaces with stable schemas. A lens is: scope (thread/mission/org/run), time range, filters, and output shape
- Add projection types: RunHealth (active runs, stale runs, failed reconciliations), RiskDashboard (blocked threads, escalations, policy violations), MissionProgress (completion %, active threads, blockers), TransportHealth (outbox depth, dead-letter count, delivery success rate), FederationStatus (remote workspace health, last sync, capability matrix)
- Each projection is servable via MCP tool and HTTP endpoint — operators can query them programmatically or render them in the web control plane
- Every control-plane subsystem (dispatch, transport, federation, triggers, autonomy) must expose a health/status projection — not just internal correctness
- The web control plane (apps/web-control-plane) gets updated routes for each projection type

The exit criterion for this phase: a human operator opening WorkGraph should immediately see what exists, what is active, what is unhealthy, and what needs intervention.

## Constraints

- Zero new runtime dependencies beyond what's in package.json (commander, gray-matter, yaml, zod, @modelcontextprotocol/sdk). Use node:fs, node:path, node:crypto for everything else
- All state is markdown files with YAML frontmatter in .workgraph/ — no databases, no external storage
- Every new public interface gets vitest tests. Target the same coverage density as existing code (~450 tests across 89 files)
- The monorepo build uses tsup. All packages must build cleanly. The existing tsup.config.ts shapes are the pattern to follow
- Preserve backward compatibility: existing MCP tools, CLI commands, webhook endpoints, and workspace files must continue to work unchanged
- The ledger is append-only and hash-chained. Never mutate existing ledger entries
- Follow existing code patterns: frontmatter-first markdown files, zod validation for inputs, explicit error types, structured result objects

## Definition of Done

- All 446+ existing tests pass
- Each phase adds comprehensive tests for its new functionality
- `npx vitest run` passes with zero failures
- The Cursor cloud adapter can dispatch a run, survive a process restart, and reconcile from external state
- Trigger deliveries flow through the transport outbox with dead-letter and replay capability
- Federation resolves typed cross-workspace refs with capability negotiation
- No concrete adapter logic remains in packages/kernel
- Every major subsystem exposes an operator-readable projection via MCP tool
- The codebase builds cleanly with `npx tsup` across all packages
