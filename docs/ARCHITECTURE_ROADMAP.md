# WorkGraph Architecture Roadmap

Date: 2026-03-11
Status: Active execution roadmap

## Purpose

This roadmap translates the current WorkGraph vision into the next architectural
execution phases.

The intent is not to expand the surface area randomly. The intent is to turn
WorkGraph from a strong local coordination kernel into a real cross-runtime,
policy-governed, operator-visible company coordination fabric.

## What Is Already True

- The package-first monorepo shape is correct.
- `packages/kernel` is the right home for truth, lifecycle, policy, triggers, and autonomy semantics.
- `packages/runtime-adapter-core` is the right home for shared adapter contracts and generic transports.
- `packages/mcp-server` and `packages/control-api` are the right external surfaces.
- Local-first markdown + ledger remains a strategic advantage and should stay canonical.

## Core Architectural Delta

The next roadmap is not a package explosion. It is a control-plane hardening and
runtime-fabric roadmap across five architectural seams:

1. External run broker and runtime correlation
2. Explicit event transport fabric
3. Protocol-aware constrained federation
4. Runtime composition cleanup
5. First-class projections and operator lenses

## Phase 1: External Run Broker

### Goal

Make WorkGraph runs first-class wrappers around external runtime executions, not
just local adapter invocations.

### Why

Cross-runtime coordination fails if WorkGraph cannot reliably correlate its own
`run` primitive with an external runtime job, session, webhook, or execution ID.

### Deliverables

- Extend `run` state to include provider-specific external run identity and
  correlation metadata
- Normalize external status, log, cancel, follow-up, and evidence reconciliation
- Add durable inbound reconciliation for runtime webhooks/events
- Add durable outbound dispatch tracking so retries and recovery are explicit
- Make Cursor cloud/background execution the first production-grade external path

### Exit

- A run can survive process restarts and still reconcile with the same external
  runtime execution
- The same WorkGraph thread can dispatch, observe, cancel, and complete work
  across at least one true external runtime without manual operator stitching

## Phase 2: Event Transport Fabric

### Goal

Separate domain truth from delivery mechanics so automation, replay, federation,
  and external runtimes all use the same explicit transport contract.

### Why

The ledger should remain the audit source of truth, but delivery, replay, retry,
dead-letter handling, and inbound reconciliation need first-class transport
records rather than implicit side effects of ledger reads.

### Deliverables

- Define outbound event envelope contract and persistence model
- Add explicit outbox/inbox records for external event delivery and reconciliation
- Add replay, dead-letter, and operator inspection flows
- Keep ledger append as the durable audit record while transport records govern
  delivery state

### Exit

- Triggers, webhooks, runtime bridges, and future federation do not depend on
  ad hoc event polling semantics
- Failed deliveries are inspectable, replayable, and policy-governed

## Phase 3: Protocol-Aware Federation

### Goal

Turn current path-based federation into an explicit same-trust-domain federation
model that can later grow into network federation without rewriting the kernel.

### Why

The current federation layer is useful but still assumes mounted local paths.
The vision requires safe cross-workspace references, queries, and eventually
remote transport-backed collaboration.

### Deliverables

- Formalize remote workspace identity, protocol, and capability metadata
- Add typed federated links and dereference semantics
- Add constrained read-only federation as the first supported trust model
- Add compatibility/version negotiation hooks for future HTTP/MCP remotes
- Define conflict/authority rules clearly before writable federation exists

### Exit

- Cross-workspace refs and queries are explicit, typed, and inspectable
- Federation is no longer just “another local path in config”

## Phase 4: Runtime Composition Cleanup

### Goal

Remove remaining runtime-specific composition from kernel bootstrapping so
WorkGraph stays runtime-agnostic at its core.

### Why

The moat is not “we support Cursor today.” The moat is “any runtime can execute
against the same trusted coordination substrate.”

### Deliverables

- Move concrete adapter assembly out of kernel-owned registries where possible
- Make runtime registration/composition flow through package-owned adapter
  surfaces and shared contracts
- Reduce duplicate runtime lifecycle semantics across kernel and adapter layers
- Keep kernel focused on orchestration semantics, not runtime instantiation

### Exit

- Kernel defines coordination behavior without hardcoding concrete runtime
  composition as the long-term model
- Adding a new runtime becomes a package/composition change, not a kernel rewrite

## Phase 5: Projections and Operator Surface

### Goal

Make WorkGraph feel like a company operating surface, not just a capable kernel.

### Why

If the product never becomes watchable, explainable, and operationally legible,
it risks collapsing into infrastructure admired only by its builders.

### Deliverables

- Promote lenses/projections into explicit read-model contracts
- Add stronger run, risk, incident, and autonomy attention surfaces
- Ensure every major control-plane subsystem yields operator-readable state, not
  just internal correctness
- Tie runtime outcomes back into thread-, mission-, and org-level views

### Exit

- A human operator can open WorkGraph and immediately understand what exists,
  what is active, what is unhealthy, and what needs intervention
- The system visibly feels like “the company is running on WorkGraph”

## Sequencing Rules

- Do not add many new adapters before one true external runtime path is
  production-grade.
- Do not attempt writable federation before read-only federation identity and
  authority rules are explicit.
- Do not add more trigger power without transport, replay, and operator
  visibility improving with it.
- Do not move kernel logic into control surfaces just to ship faster.
- Do not let product UX drift away from the actual trusted system state.

## Can Defer

The following are valid roadmap items, but they should not outrank the five core
architectural seams above:

- many additional runtime adapters beyond the first production-grade external
  path
- writable cross-workspace federation
- richer programmable trigger sandboxes beyond today’s composable conditions and
  safety rails
- fully self-organizing dashboard behavior
- broad cloud-product packaging work before the local control plane is more
  operationally coherent

## Definition of Success

WorkGraph should be able to truthfully claim all of the following:

- Local-first truth remains canonical
- External runtimes can execute safely against shared run contracts
- Automation delivery is replayable and governable
- Federation is explicit and trusted, not accidental
- Operator views are first-class projections of the same truth layer
- The system coordinates humans and multiple runtimes without collapsing into any
  single runtime vendor’s box
