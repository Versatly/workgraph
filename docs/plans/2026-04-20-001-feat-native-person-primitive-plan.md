---
title: feat: Native person primitive and agent-native primitive surfaces
type: feat
status: active
date: 2026-04-20
---

# feat: Native person primitive and agent-native primitive surfaces

## Overview

Promote `person` into the retained native primitive model, give it a strong canonical markdown/frontmatter schema for contact and relationship data, and rebuild the primitive surface so kernel, CLI, and MCP all speak the same clean language:

- primitive **types** are schemas/templates in the registry
- primitive **instances** are canonical markdown entries in workspace folders
- CLI and MCP expose the same type/instance contract, with ergonomic domain overlays for agent workflows

The result should let agents and humans create, traverse, update, archive, and relate people naturally while preserving markdown/frontmatter as the source of truth and keeping CLI/MCP as thin layers over kernel behavior.

## Problem Frame

The repo already has a broader primitive catalog than its currently retained built-in set. `person`, `client`, and `project` are already modeled in `packages/kernel/src/registry.ts`, but fresh workspaces do not retain them, so they are missing from the active canonical workspace model. At the same time, the current naming and surface design blur the distinction between primitive schemas and primitive instances. That ambiguity makes it harder to build a native, agent-friendly CLI/MCP experience and harder to reason about what the canonical data model actually is.

We need a cleaner primitive architecture that treats people as first-class canonical context, clarifies the schema-vs-instance split, and exposes agent-native CRUD/query/discovery paths across CLI and MCP without creating duplicate domain logic or a sprawl of bespoke one-off commands.

## Requirements Trace

- R1. `person` is a retained native primitive in fresh and existing workspaces.
- R2. `person` instances are canonical markdown files in `people/*.md` with robust contact-oriented frontmatter and optional narrative body.
- R3. The system clearly distinguishes primitive **types** from primitive **instances** in kernel, CLI, MCP, and docs.
- R4. CLI and MCP share one canonical primitive contract for type discovery, schema inspection, and instance CRUD/query flows.
- R5. Agent-native ergonomics are preserved through deterministic JSON/structured outputs, stable naming, and clean permission/error semantics.
- R6. Domain-specific affordances for people are available where they add UX value, but they remain thin overlays on the canonical primitive contract.
- R7. Supporting retained primitives needed for `person` relationships are handled explicitly rather than left as dangling refs.
- R8. Existing published-surface compatibility is preserved where reasonable through aliases and staged cleanup.

## Scope Boundaries

- This plan does not re-open the entire historical primitive catalog as retained native scope.
- This plan does not redesign thread/workflow lifecycle semantics for entity primitives like `person`.
- This plan does not introduce a new storage backend; markdown/frontmatter remains canonical.
- This plan does not move policy logic out of kernel.

### Deferred to Separate Tasks

- Additional domain-specific retained primitives beyond `person`, `client`, and `project` if future product scope requires them.
- Rich UI surfaces over people/projects if a web or desktop control-plane is introduced later.

## Context & Research

### Relevant Code and Patterns

- `packages/kernel/src/registry.ts` already defines `person`, `client`, and `project`, but they are excluded from `RETAINED_BUILT_IN_TYPE_NAMES`.
- `packages/kernel/src/store.ts` is the canonical primitive-instance CRUD layer and already handles defaults, validation, `etag`, `_wg_type`, and archive semantics.
- `packages/kernel/src/bases.ts` currently derives canonicality from `builtIn`, which overloads schema origin and retained/canonical meaning.
- `packages/kernel/src/workspace.ts` and `packages/kernel/src/starter-kit.ts` control fresh-workspace convergence.
- `packages/cli/src/cli.ts` currently treats `primitive` as a mixed schema/instance noun and has no dedicated CLI parity for schema/get/delete flows.
- `packages/mcp-server/src/mcp/tools/primitive-tools.ts` already provides a generic instance CRUD surface and is the strongest current pattern for agent-native primitive access.
- `packages/mcp-server/src/mcp/result.ts` and `packages/mcp-server/src/mcp/tools/collaboration-tools.ts` provide the best existing pattern for structured MCP outputs and retry-safe write behavior.

### Institutional Learnings

- Repo architecture documents consistently require one kernel contract with thin adapters and markdown/frontmatter as canonical truth.
- Current MCP tests already assume `person` is available through generic primitive CRUD, which suggests the intended end state is generic primitive parity first, not a wholly separate people subsystem.
- There is no existing `docs/solutions/` corpus to constrain the design, so the plan should lean on repo docs, tests, and current package boundaries.

### External References

- MCP docs and current SDK guidance favor stable capability-scoped tools, structured outputs, and a clear split between resources and tools.
- Agent-native design guidance favors generic CRUD as the platform contract, with domain aliases as thin ergonomic overlays rather than the only access path.
- CLI best practices for large multi-entity systems favor noun-first grouping with deterministic machine-readable outputs.

## Key Technical Decisions

- **Introduce an explicit retained/canonical dimension for primitive types.** `builtIn` should continue to answer "shipped by the product" while a new flag answers "retained as canonical in live workspaces". This removes the current overload where `builtIn` also drives manifest/bases generation.
- **Model type and instance as separate first-class concepts.** Type/schema operations should be visibly separate from instance CRUD/query operations in kernel terminology, CLI nouns, MCP tools/resources, and docs.
- **Promote `person` into the retained native set and promote `client`/`project` only where needed to support valid native refs.** This avoids dangling relationship fields and keeps the retained set intentional.
- **Keep generic primitive CRUD as the canonical API surface.** Domain-specific people commands/tools should compile to the same kernel/store contract rather than inventing a second storage path.
- **Use domain overlays only where they materially improve vocabulary or agent UX.** A `person` noun is valuable; a completely separate people-only model is not.
- **Preserve markdown/frontmatter instances as canonical truth.** `people/*.md`, `clients/*.md`, and `projects/*.md` remain the real graph nodes, not generated templates or side indexes.
- **Unify CLI/MCP naming and output semantics around the same conceptual layers.** Type discovery, schema inspection, CRUD, query, and archive behavior should feel equivalent across both interfaces.
- **Normalize permission handling through kernel authorization, not interface-specific policy inventions.** CLI and MCP may differ in transport/auth context, but capability and mutation semantics should come from the same kernel rules.

## Open Questions

### Resolved During Planning

- **Should `person` be modeled as a built-in primitive type or a bespoke subsystem?** It should be a retained native primitive type.
- **What is canonical: templates or entries?** Primitive instances (markdown entries) are canonical; registry/types and `.base` files are metadata/derived artifacts.
- **Should CLI/MCP expose only person-specific commands?** No. Generic primitive type/instance surfaces stay canonical; person-specific affordances are overlays.
- **Should markdown/frontmatter remain the source of truth?** Yes.

### Deferred to Implementation

- **Exact final `person` field set:** planning can define the shape and rationale, but exact field names like `preferred_name`, `timezone`, `social_handles`, or `postal_address` may need one final normalization pass during implementation review.
- **Whether `person` should immediately appear in `orientation.brief()`, `companyContext()`, and built-in lenses:** the plan will structure for it, but the implementation can decide whether to land this in the first rollout or in a tightly-coupled follow-up unit.
- **Which compatibility aliases should be permanent vs transitional:** this depends on package-maintenance appetite once implementation reveals blast radius.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```text
Primitive Type Layer
  registry.json
    -> retained/canonical type metadata
    -> field definitions, directories, ref constraints

Primitive Instance Layer
  people/*.md, projects/*.md, clients/*.md
    -> frontmatter fields
    -> markdown body
    -> validated by store.ts

Kernel Contract
  registry: list/get/define/extend retained types
  store: create/get/update/delete/query/archive primitive instances
  auth/policy: mutation authorization for both CLI and MCP

CLI Surface
  primitive-type ...
  primitive ...
  person ...
    -> thin wrappers over kernel
    -> deterministic --json outputs

MCP Surface
  resources: registry/type schema/reference context
  tools: primitive_type_*, primitive_*, person_* aliases
    -> structuredContent + outputSchema
    -> retry-safe writes where needed
```

## Implementation Units

- [ ] **Unit 1: Retained primitive model cleanup in kernel**

**Goal:** Separate primitive schema origin from retained/canonical workspace presence, then promote `person` into the retained native set with supporting retained relationships.

**Requirements:** R1, R2, R3, R7

**Dependencies:** None

**Files:**
- Modify: `packages/kernel/src/registry.ts`
- Modify: `packages/kernel/src/types.ts`
- Modify: `packages/kernel/src/bases.ts`
- Test: `packages/kernel/src/registry.test.ts`
- Test: `packages/kernel/src/bases.test.ts`

**Approach:**
- Introduce explicit retained/canonical metadata for primitive types instead of deriving canonicality from `builtIn`.
- Promote `person` into the retained native set and explicitly decide whether `client` and `project` must also become retained to satisfy ref validation cleanly.
- Refine the native `person` schema to include a richer but disciplined contact/relationship frontmatter shape while preserving markdown body support.
- Keep directories entity-scoped (`people/`, `clients/`, `projects/`) to avoid `_wg_type` coupling unless a deliberate shared-directory decision emerges.

**Patterns to follow:**
- `packages/kernel/src/store.ts` for type-driven validation/defaults
- `packages/kernel/src/registry.ts` built-in type pattern
- `packages/kernel/src/bases.ts` manifest and `.base` generation

**Test scenarios:**
- Happy path: fresh registry seed includes `person` as retained/canonical and exposes its schema metadata.
- Happy path: `person` schema includes required contact fields/defaults without breaking existing retained type definitions.
- Edge case: existing workspace registry missing `person` is upgraded idempotently without duplicating or corrupting built-in entries.
- Edge case: retained/canonical metadata for built-ins and runtime-defined types remains distinguishable.
- Error path: redefining retained built-ins still fails with clear errors.
- Integration: primitive registry manifest and generated `.base` files include retained `person` consistently.

**Verification:**
- Fresh and upgraded workspaces both expose `person` natively through the registry and bases pipeline.

- [ ] **Unit 2: Workspace bootstrap and migration convergence**

**Goal:** Ensure new and existing workspaces converge on the native retained primitive set and supporting docs/generated artifacts.

**Requirements:** R1, R2, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/kernel/src/workspace.ts`
- Modify: `packages/kernel/src/starter-kit.ts`
- Test: `packages/kernel/src/workspace.test.ts`

**Approach:**
- Update workspace initialization so retained primitive metadata, directories, manifests, and bases are created consistently.
- Decide whether starter content should seed example `person`/`client`/`project` docs or only directories and schema visibility.
- Ensure registry refresh on existing workspaces is additive/idempotent and does not rewrite user content unnecessarily.

**Patterns to follow:**
- `packages/kernel/src/workspace.ts` init flow
- `packages/kernel/src/starter-kit.ts` seeded type pattern

**Test scenarios:**
- Happy path: new workspace initialization creates retained primitive directories and manifest/bases entries for `person`.
- Happy path: existing workspace upgrade adds missing retained primitive metadata without deleting user-created docs.
- Edge case: init reruns remain idempotent.
- Integration: workspace init plus registry save/load yields the same retained primitive inventory on repeat runs.

**Verification:**
- A workspace created from scratch or reopened later exposes the same retained primitive model.

- [ ] **Unit 3: Kernel primitive instance semantics for people context**

**Goal:** Finalize how `person` instances behave as canonical graph nodes, including relationship validation and optional read-model integration.

**Requirements:** R2, R4, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/kernel/src/store.ts`
- Modify: `packages/kernel/src/orientation.ts`
- Modify: `packages/kernel/src/lens.ts`
- Modify: `packages/kernel/src/context-graph-contract.ts`
- Test: `packages/kernel/src/store.test.ts`
- Test: `packages/kernel/src/orientation.test.ts`
- Test: `packages/kernel/src/lens.test.ts`
- Test: `packages/kernel/src/context-graph-contract.test.ts`

**Approach:**
- Keep `store.ts` as the only canonical instance CRUD path and ensure `person` fields/refs validate cleanly.
- Decide whether `person` should participate in default company-context and lens outputs immediately or whether those read models should remain thread-centric in the first pass.
- If promoted into the default context graph contract, update contract invariants and snapshots deliberately instead of letting them drift implicitly.

**Execution note:** Start with characterization coverage for current retained-registry/context behavior before changing default context outputs.

**Patterns to follow:**
- `packages/kernel/src/store.ts` instance CRUD and ref validation
- `packages/kernel/src/orientation.ts` context summary pattern
- `packages/kernel/src/lens.ts` derived read-model pattern

**Test scenarios:**
- Happy path: creating a `person` instance writes canonical frontmatter/body and validates contact fields.
- Happy path: `project.member_refs` and `client.contact_ref` validate against retained `person` refs.
- Edge case: optional body remains empty-safe while frontmatter-only person docs still serialize correctly.
- Error path: invalid `person` ref targets fail validation with actionable errors.
- Integration: query/search/context contract include `person` when promoted into default read models.

**Verification:**
- Person instances are valid canonical graph nodes and integrate with relationship-aware kernel behavior intentionally.

- [ ] **Unit 4: CLI redesign for primitive-type, primitive-instance, and person ergonomics**

**Goal:** Rebuild CLI commands so schema and instance operations are clearly separated and agent-friendly, while preserving compatibility aliases.

**Requirements:** R3, R4, R5, R6, R8

**Dependencies:** Units 1-3

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Create: `packages/cli/src/cli/commands/primitive-types.ts`
- Create: `packages/cli/src/cli/commands/primitives.ts`
- Create: `packages/cli/src/cli/commands/people.ts`
- Modify: `packages/cli/src/cli/core.ts`
- Test: `tests/cli/primitive-types-command.test.ts`
- Test: `tests/cli/primitives-command.test.ts`
- Test: `tests/cli/people-command.test.ts`

**Approach:**
- Split the overloaded current `primitive` command family into clearer command modules to avoid further growth in `cli.ts`.
- Introduce distinct nouns for schema/type and instance operations, while preserving existing `primitive define/list/create/update` behavior as aliases where needed.
- Add a native `person` command family for high-value vocabulary (`list`, `show`, `create`, `update`, `archive`) that delegates to the same kernel contract as generic primitive-instance commands.
- Keep outputs deterministic with `--json` and stable field names designed for autonomous agents.

**Patterns to follow:**
- Existing noun-first CLI grouping in `packages/cli/src/cli.ts`
- `packages/cli/src/cli/core.ts` JSON/error/auth wrapper conventions

**Test scenarios:**
- Happy path: type commands list/show `person` schema with deterministic JSON.
- Happy path: generic primitive-instance commands create/show/update/archive a `person` instance.
- Happy path: `person` commands produce equivalent underlying results to generic primitive-instance commands.
- Edge case: compatibility aliases keep existing primitive commands working for published users.
- Error path: invalid field assignments, missing required fields, and bad refs return clear machine-parseable failures.
- Integration: CLI-created `person` entries are immediately visible to query/search and MCP surfaces.

**Verification:**
- Agents can discover and manipulate people through a clear CLI without needing bespoke scripts or hidden contract knowledge.

- [ ] **Unit 5: MCP redesign for native agent-facing primitive and person surfaces**

**Goal:** Make MCP a first-class agent-native surface for primitive types, instances, and people, with clean naming, structured outputs, and resource/tool separation.

**Requirements:** R3, R4, R5, R6, R8

**Dependencies:** Units 1-3

**Files:**
- Modify: `packages/mcp-server/src/mcp-server.ts`
- Modify: `packages/mcp-server/src/mcp/resources.ts`
- Modify: `packages/mcp-server/src/mcp/result.ts`
- Modify: `packages/mcp-server/src/mcp/tools/primitive-tools.ts`
- Modify: `packages/mcp-server/src/mcp/tools/read-tools.ts`
- Create: `packages/mcp-server/src/mcp/tools/person-tools.ts`
- Test: `packages/mcp-server/src/mcp-server.test.ts`
- Test: `packages/mcp-server/src/mcp-http-server.test.ts`

**Approach:**
- Preserve generic primitive type/instance MCP tools as the canonical capability layer.
- Expand MCP resources for registry/type schema/reference context where passive consumption is more appropriate than imperative reads.
- Standardize structured outputs and stable error codes for primitive tools using the repo’s stronger collaboration-tool patterns where appropriate.
- Add native `person` MCP affordances only as ergonomic overlays that map onto the same kernel/store contract.
- Decide whether to keep `workgraph_*` and `wg_*` as separate semantic namespaces or gradually unify primitive/domain naming under a clearer convention.

**Patterns to follow:**
- `packages/mcp-server/src/mcp/tools/primitive-tools.ts` generic CRUD pattern
- `packages/mcp-server/src/mcp/tools/collaboration-tools.ts` structured/idempotent write pattern
- `packages/mcp-server/src/mcp/resources.ts` passive context/resource pattern

**Test scenarios:**
- Happy path: MCP can discover retained `person` type metadata and schema.
- Happy path: generic primitive MCP tools create/get/update/archive `person` instances.
- Happy path: person-specific MCP tools, if added, remain behaviorally equivalent to generic primitive tools.
- Edge case: structured outputs remain stable across stdio and HTTP transports.
- Error path: policy denial, validation errors, missing paths, and concurrency conflicts return machine-actionable envelopes.
- Integration: MCP-created `person` entries are readable through CLI and kernel query/search flows.

**Verification:**
- Autonomous agents can fully traverse and manage people natively through MCP without special-case hidden behavior.

- [ ] **Unit 6: Authorization and policy parity across CLI and MCP**

**Goal:** Normalize mutation semantics so primitive operations follow one permission model, regardless of interface.

**Requirements:** R4, R5, R6

**Dependencies:** Units 4-5

**Files:**
- Modify: `packages/kernel/src/auth.ts`
- Modify: `packages/kernel/src/policy.ts`
- Modify: `packages/kernel/src/server-config.ts`
- Modify: `packages/mcp-server/src/mcp/auth.ts`
- Modify: `packages/kernel/src/store.ts`
- Test: `packages/kernel/src/policy.test.ts`
- Test: `packages/kernel/src/agent.test.ts`
- Test: `packages/mcp-server/src/mcp-server.test.ts`

**Approach:**
- Keep kernel authorization as the only source of truth for mutation permissions.
- Review per-type capability mapping for retained entity primitives so `person` does not accidentally become ungoverned or over-constrained.
- Clarify the intended difference between CLI auth fallback modes and MCP’s explicit `mcp:write` gating, and document which deltas are intentional transport differences versus historical accidents.
- Preserve explicit exceptions like registration request flows where lower-friction access is intentional.

**Patterns to follow:**
- `packages/kernel/src/auth.ts` decision + audit pattern
- `packages/mcp-server/src/mcp/auth.ts` transport-side gate wrapper

**Test scenarios:**
- Happy path: authorized actors can mutate `person` instances through both CLI and MCP.
- Edge case: auth fallback behavior remains explicit in hybrid/legacy modes.
- Error path: missing capabilities/scopes deny mutations with stable reasons.
- Integration: denied MCP operations and denied CLI operations correspond to the same kernel permission rules.

**Verification:**
- Interface choice no longer changes the primitive permission model unexpectedly.

- [ ] **Unit 7: Contracts, docs, and end-to-end parity coverage**

**Goal:** Lock the redesigned primitive model into tests, schemas, and docs so it stays stable for both humans and agents.

**Requirements:** R1-R8

**Dependencies:** Units 1-6

**Files:**
- Modify: `schemas/primitive.schema.json`
- Modify: `README.md`
- Modify: `SKILL.md`
- Modify: `docs/PRD.md`
- Modify: `docs/PACKAGE_BOUNDARIES.md`
- Test: `packages/testkit/src/contracts/schema-conformance.test.ts`
- Test: `tests/integration/person-primitive-parity.test.ts`

**Approach:**
- Update public schema/docs to reflect the explicit type-vs-instance model and the native retained `person` primitive.
- Add end-to-end parity coverage that proves the same canonical person entry can be created/traversed through kernel, CLI, and MCP.
- Document the recommended agent-facing workflows and domain vocabulary so future surfaces follow the same contract.

**Patterns to follow:**
- Existing schema-conformance tests in `packages/testkit`
- README/PRD emphasis on CLI-first, markdown-canonical, thin-adapter design

**Test scenarios:**
- Happy path: schema fixtures validate retained person instances.
- Happy path: one end-to-end parity test creates a person, updates it, queries it, and archives it across interfaces.
- Edge case: compatibility docs explain aliases and canonical surfaces without contradiction.
- Integration: docs and tests agree on the same primitive type/instance vocabulary.

**Verification:**
- The redesigned primitive model is explicit, testable, and durable for future contributors and agents.

## System-Wide Impact

- **Interaction graph:** registry, workspace init, store validation, bases generation, CLI command graph, MCP tool/resource registration, and auth/policy checks all change together.
- **Error propagation:** validation and policy failures should continue to originate in kernel and surface through CLI/MCP with interface-appropriate structured wrappers.
- **State lifecycle risks:** retained-set migration can silently drift if manifest/bases/workspace init are not updated in lockstep; CLI/MCP alias layers can drift if they are not bound to one canonical kernel contract.
- **API surface parity:** CLI, MCP stdio, MCP HTTP, SDK exports, and public schemas all need coordinated updates.
- **Integration coverage:** kernel-only unit tests are insufficient; parity tests must cross kernel + CLI + MCP boundaries.
- **Unchanged invariants:** markdown/frontmatter remains canonical, kernel owns domain logic, thread/workflow primitives keep their richer lifecycle semantics, and `.base` files remain derived rather than canonical.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `person` promotion introduces retained-set churn without a clean retained/canonical model | Introduce explicit retained/canonical metadata before broadening the retained set |
| People refs (`client`, `project`) remain dangling or partially modeled | Explicitly decide supporting retained primitives in Unit 1 rather than leaving refs implicit |
| CLI/MCP compatibility breaks for published users | Add compatibility aliases and cover them with regression tests |
| Interface-specific auth behavior remains inconsistent | Centralize semantics in kernel auth and add parity tests |
| MCP naming/output changes create agent integration churn | Standardize naming and structured outputs incrementally with documented compatibility |
| `cli.ts` and MCP tool modules become harder to maintain | Split commands/tools into focused files as part of the redesign |

## Alternative Approaches Considered

- **Promote `person` only and leave CLI/MCP mostly unchanged:** rejected because it preserves the schema-vs-instance ambiguity and leaves agent-native parity incomplete.
- **Introduce only person-specific commands/tools and skip generic primitive cleanup:** rejected because it creates a second model and does not scale to future retained primitives.
- **Treat only registry/templates as primitives and rename all entries to something else immediately:** partially attractive conceptually, but too disruptive for current architecture and public contracts. Better to clarify type-vs-instance semantics without discarding the existing primitive-instance model.

## Documentation / Operational Notes

- Existing workspaces need an idempotent migration/convergence path rather than a manual registry reset.
- Public docs should explicitly define primitive type vs primitive instance and document the native `person` frontmatter contract.
- If the person schema is expanded significantly, include one canonical example markdown document in docs or fixtures.

## Sources & References

- Related code: `packages/kernel/src/registry.ts`
- Related code: `packages/kernel/src/store.ts`
- Related code: `packages/kernel/src/workspace.ts`
- Related code: `packages/cli/src/cli.ts`
- Related code: `packages/mcp-server/src/mcp/tools/primitive-tools.ts`
- Related code: `packages/mcp-server/src/mcp/tools/collaboration-tools.ts`
- Related docs: `docs/PACKAGE_BOUNDARIES.md`
- Related docs: `docs/PRD.md`
- External docs: https://modelcontextprotocol.io/docs
- External docs: https://clig.dev/
