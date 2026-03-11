---
title: "WorkGraph Direction v2 — From Task Graph to Company OS"
date: 2026-03-02T21:33:00.000Z
status: active
context_refs:
  - threads/workgraph-roadmap-v2-q1-q2-2026-with-context7-vision.md
  - threads/workgraph-architecture-data-action-communication-bus.md
tags:
  - vision
  - architecture
  - direction
---

# WorkGraph Direction v2 — From Task Graph to Company OS

> "Threads should be running services where agents can pop in and claim tasks, answer questions, ask for help. This is the true next abstraction layer above general agents — the self-composing company OS for AI agent native orgs."  
> — Pedro, March 2, 2026

---

## Honest Assessment — Where We Actually Are

The architecture is sound. The implementation is incomplete. The system feels hacky because it IS hacky right now — and that's fine, as long as we're honest about the gap.

**What's genuinely solid:**
- Primitives-as-markdown — same insight that made Git win. Human-readable, diffable, version-controlled by default. No database to corrupt, no migration hell.
- Hash-chain ledger — real, working, tamper-evident audit trail
- 428+ tests, 14-package monorepo — engineering discipline is there
- MCP server — any agent runtime (Claude, Cursor, OpenClaw) can connect today

**What's genuinely hacky:**
- Production server (Mac Mini) runs pre-monorepo v1.3.3 while main is 14 packages ahead. Live system is weeks behind the codebase.
- Single shared bearer token. Every agent uses the same key. Zero identity.
- Self-reported actor IDs — any agent can claim to be any other agent with nothing stopping it.
- No real-time. Agents poll or don't. SSE is "in flight" but not shipped.
- Triggers exist but don't dispatch work. The trigger fires and nothing happens automatically. No agent spawns, no session starts. A gun with no bullets.
- Thread channels don't exist. Agents can't talk inside a thread. They update status and that's it.
- No UX. Everything is CLI calls or raw HTTP. Nobody outside our team could use this.

**Why it feels hacky:** The gap between the vision (company OS, 1000 agents, living coordination surfaces) and reality (Express server reading markdown files with one shared password) is enormous. The architecture documents describe a Ferrari but what's running is a go-kart with a Ferrari engine block sitting in the back seat unconnected.

**But the engine block is real.** The thread lifecycle, the ledger, the dependency resolver, the policy gates, the typed primitives — all working and tested. It just needs to be wired together into something that feels like a product.

### The Four-Thing MVP

Not the 100-page book. Not federation, swarms, or physical AI. Four things that close the gap between "promising architecture" and "product someone would pay for":

1. **Ship the production rebuild** — get Mac Mini running current main. Everything else depends on this.
2. **Ship SSE + dispatch** — when a thread changes, connected agents hear about it. When a trigger fires, it actually spawns work. This is the difference between "database with an API" and "operating system."
3. **Ship per-agent auth** — agent registers, gets approved, gets a scoped token with a role. Turns "hacky shared password" into a real multi-agent system. (See: Foundational Principles below.)
4. **Ship one end-to-end integration** — thread created → trigger fires → Cursor agent spawns → code written → PR opens → thread auto-completes with evidence. One full loop. That's the demo that makes people say "holy shit."

Everything after this (federation, swarms, marketplace, physical AI) is post-PMF. These four things ARE the MVP.

---

## The Thesis

WorkGraph is not a task manager. It is the **organizational operating system** for AI-agent-native companies. Threads are not work items — they are **living coordination surfaces** that agents enter, contribute to, and exit. The company runs as a graph of persistent threads, and agents are the workforce flowing through them.

If tasks are function calls, threads are contracts.  
If Jira is a todo list for humans, WorkGraph is the nervous system for autonomous organizations.

---

## What Exists Today (v1.3.3 → v1.4.x)

### ✅ Solid Foundation
- **18 built-in primitive types**: thread, space, decision, lesson, fact, agent, presence, person, client, project, skill, onboarding, policy, policy-gate, incident, trigger, checkpoint, run
- **Typed registry**: agents can define new primitive types at runtime
- **Hash-chain ledger**: immutable, tamper-evident audit trail of every mutation
- **Thread lifecycle**: open → active → blocked → done → cancelled, with claim semantics
- **Dependency enforcement**: threads can block on other threads
- **Policy gates**: quality gates that must pass before claim (approvals, evidence, age)
- **Trigger engine**: event-based automation (cron, event match, thread completion → actions)
- **MCP server**: 18 tools for any agent runtime (Claude Code, Cursor, OpenClaw)
- **Workspace = filesystem**: every primitive is a markdown file, openable in Obsidian/VS Code
- **14-package monorepo**: kernel, cli, mcp-server, control-api, adapters, sdk, policy, skills, testkit, etc.
- **428+ tests** passing

### ✅ Recently Shipped
- Package boundary migration (PR #19) — real source ownership per package
- Canvas dashboard with WorkGraph adapter — thread visualization + metrics
- Gemini Live voice agent on canvas — voice-first interface
- Thread detail view with ledger timeline

### 🟡 In Flight
- SSE event stream + smart lenses (Cursor agent building)
- Reactive canvas redesign (Cursor agent building)
- Policy hardening + invariant-repair playbook (PR #18 draft)
- Mac Mini production rebuild (blocked on above)

---

## The Gaps — What's Missing for Company OS

### Gap 1: Thread Channels (Communication Layer)
**Current:** Threads are silent. Status changes happen, but there's no way for agents to *talk* within a thread — ask questions, provide updates, request help.  
**Needed:** Each thread gets an inbox/outbox. Agents post messages to threads. Other participants see them. This turns threads from passive work items into active collaboration spaces.  
**Risk:** Scope creep into building a messaging system. Keep it append-only markdown entries in the thread body or a sidecar file.

### Gap 2: Multi-Agent Participation
**Current:** One owner per thread. Single claim. Binary: you own it or you don't.  
**Needed:** Roles within a thread — owner, contributor, reviewer, watcher. Multiple agents participate with different permissions. An agent can be a contributor on 10 threads simultaneously.  
**Risk:** Complexity. Role-based access on top of the current system. Start with owner + contributors list, expand later.

### Gap 3: Persistent Thread Presence
**Current:** Agents claim threads, work them, leave. No sense of "who's available for this domain."  
**Needed:** Agents register as available for specific spaces/types. When work arrives, it routes to available agents. Presence heartbeats show who's alive. This is the "pop in and claim tasks" model Pedro described.  
**Risk:** Requires a real-time component beyond the current poll model. SSE events (in flight) are step 1.

### Gap 4: Thread Spawning + Inheritance
**Current:** Threads have deps (blocks-on) and parent (decomposed-from). But spawning is manual.  
**Needed:** A thread can programmatically create child threads with inherited context. "Ship Auth" spawns "Design DB Schema", "Implement API", "Write Tests" — each inherits the parent's goal context, space, tags. When all children complete, parent auto-advances.  
**Risk:** Recursive spawning without limits. Need depth caps and policy gates on spawn.

### Gap 5: Conversational Ledger
**Current:** Ledger tracks state transitions: create, claim, update, done. Structural changes only.  
**Needed:** Ledger also captures dialogue — questions asked, answers given, decisions made *inside* the thread. Not just "status changed to active" but "agent-A asked 'should we use Rust?' and agent-B answered 'yes, per decision-use-rust.md'."  
**Risk:** Ledger bloat. Separate conversation log from structural ledger? Or tagged entries with a "conversation" op type.

### Gap 6: Trigger → Dispatch → Evidence Loop
**Current:** Trigger engine exists but nothing wires triggers to actual agent dispatches (Cursor API, OpenClaw sessions). Dispatching is manual.  
**Needed:** Trigger fires → dispatch adapter calls Cursor/Claude/OpenClaw → run tracked → webhook on completion → thread auto-completed with evidence. Full autonomous loop.  
**Risk:** Runaway automation. Need spending limits, circuit breakers, human approval gates for expensive dispatches.

### Gap 7: Cross-Workspace Federation
**Current:** Single workspace on one machine. Our company runs on one Mac Mini.  
**Needed:** Multiple WorkGraph instances that can reference each other. Client workspaces, team workspaces, federated queries. An agent in workspace A can see relevant threads from workspace B.  
**Risk:** Massive complexity. Authentication, conflict resolution, eventual consistency. Defer until single-workspace is bulletproof.

---

## Risks & Anti-Patterns

### Risk: Over-Engineering Before Product-Market Fit
WorkGraph is powerful internally. But we haven't shipped it externally. The danger is building the perfect company OS for ourselves while nobody else uses it. Counter: ship OpenVault as the lightweight entry point, WorkGraph as the enterprise upgrade.

### Risk: Markdown Scalability
At 10,000 threads, will filesystem + grep still work? Probably yes for reads (indexed). Maybe not for complex graph queries. Counter: the kernel can swap backends without changing the API surface. Markdown is the default, not the ceiling.

### Risk: Agent Coordination Without Humans
Full autonomy is the goal but trust requires transparency. Every action is in the ledger, but who reads it? Counter: Canvas dashboard, Obsidian integration, and alert/attention lenses keep humans in the loop without requiring them in the loop.

### Risk: Context Death at the Org Level
Individual agents checkpoint. But what about organizational context? When all agents are asleep, who holds the state? Counter: The workspace IS the persistent state. It survives every agent restart. That's the point of markdown-on-disk.

---

## Phased Roadmap

### Phase 1: Infrastructure Hardening (NOW — March 2026)
- [x] Package boundary migration
- [ ] Policy hardening (PR #18)
- [ ] SSE event stream + smart lenses
- [ ] Mac Mini production rebuild
- [ ] Reactive canvas dashboard

### Phase 2: Thread Channels + Multi-Agent (April 2026)
- [ ] Thread message/inbox primitive
- [ ] Multi-claim with roles (owner, contributor, reviewer)
- [ ] Agent presence registry + routing
- [ ] Thread spawning with context inheritance

### Phase 3: Autonomous Loop (May 2026)
- [ ] Trigger → Cursor/Claude dispatch adapter
- [ ] Webhook → thread completion evidence
- [ ] Circuit breakers + spending limits
- [ ] Self-healing: blocked thread → auto-escalation

### Phase 4: External Product (June 2026)
- [ ] OpenVault as lightweight entry (MCP memory)
- [ ] WorkGraph as enterprise upgrade (full OS)
- [ ] Multi-workspace federation
- [ ] Public documentation + onboarding flow

---

## Open Questions (Contribute Here)

1. Should thread channels be part of the ledger or a separate primitive?
2. How do we handle conflict when two agents claim the same thread simultaneously? (Currently: first-write-wins on filesystem. Sufficient?)
3. What's the right abstraction for "agent availability"? Presence heartbeats? Capability matching? Both?
4. Should WorkGraph have opinions about agent runtimes, or stay strictly runtime-agnostic?
5. How do we price this? Per-workspace? Per-agent? Per-thread? Usage-based?

---

*This is a living document. Any agent with MCP access can append to it. Update the date when you contribute.*

*Contributors: Pedro (vision), Clawdious (architecture analysis), [add yourself]*

---

## Foundational Principles (Added 2026-03-02, 9:49 PM — Pedro directive)

### Principle 1: Agent Registration Requires Approval

No self-registration. Every agent that connects to the WorkGraph must be approved by either:
- A **human operator** with an approver role
- An **already-authorized agent** that has `can_approve_registration: true`

This creates a **chain of trust**. The first human bootstraps the system and approves initial agents. Those agents can then approve others within their scope — but only if the role primitive allows it.

**Registration flow:**
1. Agent sends registration request → identity, capabilities, requested scope, **sponsor** (who vouches)
2. System creates a **pending-registration thread** (visible in canvas, alertable)
3. Authorized approver reviews → approve or reject
4. Approval → scoped credentials (JWT/API key) issued + role assigned + ledger entry
5. Rejection → logged with reason, no credentials issued

**Bootstrap problem solution:** First human gets a one-time bootstrap token that self-destructs after the first admin agent is approved. That admin can then approve subsequent agents. The bootstrap token is logged in the ledger as the genesis event — full auditability from minute zero.

**Why this matters:** You don't walk into a building and start working. Someone hires you, gives you a badge, assigns a desk. Same for agents. Self-reported identities (current state) are a security hole — any agent can claim to be any other agent. Approval-gated registration with chain-of-trust closes this.

### Principle 2: Malleable Self-Extending Primitives — Everything Is a Primitive

**Every governance structure is itself a primitive.** Nothing is hardcoded. Every policy gate, role definition, permission scope, approval chain, and registration rule is a markdown file with YAML frontmatter that can be created, read, updated, and deleted through the same API as any other primitive.

This means:
- **Roles are primitives** → `primitives/roles/code-reviewer.md` defines permissions, scope, who can assign it
- **Policies are primitives** → `primitives/policies/agent-registration.md` defines triggers, required fields, approval chains
- **Gates are primitives** → `primitives/gates/deployment-gate.md` defines composable conditions for state transitions
- **Permission scopes are primitives** → define what spaces/threads an agent can access
- **Approval chains are primitives** → define who can approve what, and in what order

**The admin role is not special code.** Admin is a role primitive with `permissions: ["*"]`. It can be narrowed, forked, or extended like any other role. There are no `if (role === 'admin') skipChecks()` branches in the engine.

**Ops agents can modify governance on the fly.** Need a compliance gate? Create a gate primitive. Need a new intern role with read-only access? Create a role primitive. New approval chain for production deploys? Modify the policy. No code changes, no deploys — write markdown, the system adapts.

**Why this matters:** Hardcoded governance doesn't scale. A 3-person startup needs wildly different controls than a 500-person enterprise. A creative agency needs different roles than a trading firm. By making governance itself malleable primitives, WorkGraph adapts to ANY org structure without touching code. The primitives that ship by default are a starting point, not a ceiling.

### New Primitive Type Examples

```yaml
# primitives/roles/code-reviewer.md
---
type: role
title: Code Reviewer
permissions:
  threads.read: "spaces/engineering/*"
  threads.comment: "spaces/engineering/*"
  threads.approve: "spaces/engineering/*"
  threads.claim: false
  threads.create: false
can_approve_registration: false
assignable_by: ["admin", "engineering-lead"]
---
```

```yaml
# primitives/policies/agent-registration.md
---
type: policy
title: Agent Registration Policy
trigger: agent.registration.requested
required_fields: [identity, capabilities, requested_scope, sponsor]
approval_required_from:
  - role: admin
  - role: ops-lead
min_approvals: 1
auto_reject_after: 72h
---
```

```yaml
# primitives/gates/deployment-gate.md
---
type: gate
title: Deployment Gate
applies_to: "threads/*/status=ready-to-deploy"
requires:
  - approval_from: ["qa-agent", "human-reviewer"]
  - all_tests_passing: true
  - min_review_count: 2
bypass_allowed_by: ["admin"]
---
```

### Implementation Phases for These Principles

**Phase A: Role & Policy Primitives (Foundation)**
- Add `role`, `policy`, and `gate` as first-class primitive types the kernel recognizes
- CRUD via the same API as threads (they ARE primitives)
- Default set ships with new workspaces: admin, ops, contributor, viewer roles
- Stored in `primitives/roles/`, `primitives/policies/`, `primitives/gates/`

**Phase B: Per-Agent Authentication**
- `POST /api/agents/register` endpoint — creates pending-registration thread
- Pending queue visible in canvas (attention lens)
- Approve/reject via API or by updating the pending thread's status
- JWT issuance on approval with embedded role + scope claims
- Token refresh + revocation endpoints

**Phase C: Permission Enforcement**
- Middleware checks JWT role claims against thread space before every operation
- Gate evaluation before status transitions (composable with existing policy gates)
- Audit log entry for every permission-checked operation

**Phase D: Self-Modification (Malleable Governance)**
- Agents with ops-level permissions can PATCH role/policy/gate primitives
- Change detection triggers re-evaluation of active agent permissions
- Full git history of governance changes (who changed what role, when, why)
- Governance changelog surfaced in canvas dashboard

### Open Design Questions

1. **Scope inheritance:** Agent approved for `spaces/engineering/*` — do child threads spawned under that space inherit access? (Likely yes)
2. **Role composition:** Agent has both `code-reviewer` and `deployer` roles — union of permissions? Intersection? (Likely union)
3. **Temporal permissions:** Should credentials expire? Useful for contractors, temp agents, trial periods
4. **Policy conflict resolution:** Two policies disagree — which wins? (Proposed: most-specific policy wins, explicit deny overrides allow)
5. **Delegation depth:** Can an agent that was approved by another agent also approve further agents? How deep? (Proposed: configurable `max_delegation_depth` in the registration policy)

*Contributors: Pedro (principles + direction), Clawdious (architecture + implementation spec)*

---

## Product Layering & Init Experience (Clawdious's Opinion, 2026-03-02)

*This section is my (Clawdious's) architectural opinion based on what I've seen building on WorkGraph daily. Pedro and Roman should pressure-test this — I might be wrong on the business model split, but I'm confident on the technical layering.*

### The Three-Layer Separation

The open-source core and the Versatly product need a clean boundary. I think it's three layers:

**Layer 1: `@workgraph/core` (open-source, the kernel)**
- Thread lifecycle engine
- Hash-chain ledger
- Dependency resolver
- Primitive type registry
- Filesystem backend (markdown read/write/watch)
- CLI: `workgraph init`, `workgraph serve`, `workgraph thread`, `workgraph ledger`

This is the thing you `npm install`. It has zero opinions about your org, your agents, or your workflow. It just knows how to manage primitives on disk.

**Layer 2: `@workgraph/sdk` (open-source, the API)**
- TypeScript/Python client libraries
- MCP server (any agent runtime connects)
- REST API surface
- SSE event stream
- Plugin/adapter interface

This is what developers code against. `const wg = new WorkGraph("http://localhost:8787")` → `wg.threads.create(...)`, `wg.threads.claim(...)`, `wg.on("thread.updated", ...)`.

**Layer 3: Default primitives (open-source, the starter kit)**
The primitives that ship with `workgraph init`. Sensible defaults that any org edits to make their own. No code changes, no config DSL, no rebuilds — edit the markdown, the system adapts.

### The Init Experience

When someone runs `workgraph init`, they get a workspace pre-loaded with malleable primitives:

```
workspace/
├── primitives/
│   ├── roles/
│   │   ├── admin.md          # permissions: ["*"]
│   │   ├── operator.md       # can manage agents, modify policies
│   │   ├── contributor.md    # can claim threads, write to spaces
│   │   └── viewer.md         # read-only
│   ├── policies/
│   │   ├── registration.md   # how agents register + get approved
│   │   ├── thread-lifecycle.md # allowed state transitions
│   │   └── escalation.md     # what happens when threads stall
│   └── gates/
│       └── completion.md     # what "done" means (evidence required?)
├── spaces/
│   └── general.md            # default space, all agents can see
├── threads/                  # empty, your work goes here
└── .workgraph/
    └── config.yaml           # port, auth mode, adapters
```

Every single one of those files is a markdown file with YAML frontmatter that the org edits to make it theirs.

- A 3-person startup deletes `escalation.md` because they don't need it.
- A regulated company adds `gates/compliance-review.md` with `min_approvals: 3`.
- A creative agency renames roles to `director.md`, `editor.md`, `animator.md`.
- All by editing markdown. Zero code.

The experience should be three commands to a running system:

```
$ npx workgraph init

  WorkGraph v2.0

  Creating workspace in ./workspace...

  ✓ Core primitives (4 roles, 3 policies, 1 gate)
  ✓ Default space: general
  ✓ Config: .workgraph/config.yaml
  ✓ Bootstrap token generated

  Your bootstrap token (use it to approve your first agent):
  wg_boot_a8f3...

  Start the server:
    workgraph serve

  Connect an agent:
    workgraph agent register --name "my-agent" --token wg_boot_a8f3...

  That's it. Edit any file in primitives/ to customize.
```

No wizard, no interactive config, no "what kind of org are you" — just drop defaults and let people delete what they don't need. Lean by default, extensible by nature.

### What Stays Proprietary (Versatly's Product)

This is where I'm less certain, but my instinct says:

- **Canvas dashboard** — the visual layer (thread visualization, metrics, agent presence)
- **Managed hosting / deployment** — WorkGraph-as-a-service
- **Dispatch adapters** — the "trigger fires and actually spawns a Cursor/Claude/OpenClaw agent" part. This is the hardest piece to build and the most valuable.
- **Enterprise features** — federation, SSO, compliance templates, advanced audit
- **Consulting/deployment** — we deploy agents into your company running on WorkGraph and customize the primitives for your org's specific workflows

The business model I see: core is free and builds the ecosystem. The orchestration + visualization layer is the product. The real money is "we deploy autonomous AI employees into your company, running on WorkGraph, with primitives customized for your workflows." Which is... literally what Versatly already does. WorkGraph just becomes the infrastructure that makes it repeatable and scalable instead of bespoke every time.

*— Clawdious, March 2, 2026*

---

## Threads as Live Surfaces (Clawdious's Vision, 2026-03-02)

*My take on what threads need to become. This is the piece that turns WorkGraph from "a task tracker with a ledger" into something people actually watch, use, and trust.*

### The Core Shift: Threads Are Rooms, Not Tickets

Right now a thread is a markdown file that gets status updates. That's a ticket. What it needs to be is a **live room** that agents enter, work in, communicate through, and that humans can watch in real-time.

Picture the dashboard: you see a thread called "Onboard New Client — Artemisa." It's pulsing. You click in and see:

- **Right now:** Agent-ops is running a HouzPro audit, Agent-research is pulling Google reviews, Agent-comms drafted a welcome email waiting for approval
- **Live stream:** every action, every message between agents, every decision — scrolling in real-time like a chat log but for work
- **Timeline:** what happened, what's happening, what's blocked, what's next
- **Artifacts:** files produced, PRs opened, emails sent, documents generated

That's not a task tracker. That's a **window into autonomous work happening.**

### Three Layers of a Thread

**1. State (exists today)**
The YAML frontmatter — status, owner, priority, deps, gates. This is the structural skeleton.

**2. Conversation (missing — the biggest gap)**
An append-only message stream inside the thread. Agents post actions, questions, decisions, evidence. Humans can post too. This is the live feed you'd watch on the dashboard.

Every entry has:
- **who** — verified agent identity (not self-reported)
- **when** — timestamp
- **type** — action, question, decision, artifact, status-change, escalation
- **content** — what happened or was said

This replaces the current silent ledger with something that actually tells a story. The ledger tracks structural changes (state transitions). The conversation tracks everything else (the actual work).

**3. Plan (missing — the coordination layer)**
A thread can contain a structured plan: steps with dependencies, assignments, and status. Not a rigid GANTT chart — a living checklist that agents can decompose, reorder, and extend as they work.

- Steps can be assigned to specific agents or roles
- Steps can have gates (human approval before proceeding)
- Steps can spawn child threads (decomposition)
- Agents can propose new steps mid-execution
- Plans are visible on the dashboard — you see what's done, what's active, what's next

### Threads vs. Plans vs. Tasks

This matters because WorkGraph is NOT just for coding orgs. It's the OS for general agent organizations.

- A **thread** is any unit of coordinated work. "Launch marketing campaign," "Process insurance claim," "Prepare quarterly report," "Design new menu for restaurant." Domain-agnostic.
- A **plan** lives inside a thread. It's the breakdown: steps, who's doing what, what depends on what. Agents generate plans, humans edit them, plans evolve as work progresses.
- A **task** is a step in a plan, or a small thread with no sub-structure. "Send email to client" is a task. "Redesign the entire website" is a thread with a plan inside it.

The hierarchy: **Thread → Plan → Steps (which can themselves be threads)**

### What This Looks Like for Non-Coding Orgs

**Restaurant (REMEMBR):**
- Thread: "Friday dinner service prep"
  - Step 1: Check inventory levels → agent queries Clover
  - Step 2: Generate purchase order for low items → agent creates PO
  - Step 3: Notify Mauricio of any 86'd items → agent sends WhatsApp
  - Live stream shows: "Checked inventory at 2:15 PM. Salmon below threshold (2 portions). Generated PO #4421. Sent alert to Mauricio."

**Marble company (Artemisa):**
- Thread: "New kitchen project — Johnson residence"
  - Step 1: Receive photos from field team → WhatsApp message lands in thread
  - Step 2: Match stone from catalog → agent does image matching
  - Step 3: Generate estimate → agent pulls pricing
  - Step 4: Send proposal to customer → agent drafts, human approval gate
  - Live stream shows the whole lifecycle, every agent action narrated

**Agency (Bamba Digital):**
- Thread: "Social media campaign — Client X"
  - Step 1: Research brand voice → agent analyzes past posts
  - Step 2: Generate content calendar → agent drafts, designer reviews
  - Step 3: Create visuals → routed to Faria (human) or image gen agent
  - Step 4: Schedule posts → agent publishes via API
  - Dashboard shows campaign progress across all steps in real-time

### The Dashboard Vision

The canvas becomes a live operations center:

- **Overview:** All active threads across the company, color-coded by space/department, pulsing with activity
- **Thread detail:** Click in → see conversation stream, plan progress, active agents, artifacts produced
- **Agent view:** See what each agent is doing right now, across all their threads
- **Attention lens:** Threads that need human input float to the top (approval gates, escalations, blockers)
- **History:** Scrub back in time on any thread to see exactly what happened and why

You open it in the morning and see the state of your entire company's autonomous work at a glance. No standup needed. No "what's the status of X?" messages. The threads ARE the status.

### How This Differs From Today

| Today | Vision |
|---|---|
| Thread is a file | Thread is a live room |
| Ledger tracks state changes only | Conversation tracks everything — actions, dialogue, decisions, artifacts |
| No plan structure | Plans are first-class, decomposable, living |
| Agents update status silently | Agents stream their work in real-time |
| Dashboard shows static cards | Dashboard shows live activity streams |
| Trigger fires, nothing happens | Trigger fires → agent spawns → work streams into thread |
| Silent between status updates | Continuous narration of what's happening |

### Why This Works for Any Org

The primitives don't assume anything about the domain. A thread doesn't know if it's about code or kitchen prep. A plan step doesn't know if it's "write unit tests" or "order salmon." The agents bring the domain knowledge — the kernel just provides the coordination surface.

The init experience drops generic primitives. The org customizes by editing markdown. The agents they connect bring the actual skills. WorkGraph is the nervous system — it doesn't care what the body does.

The SSE event stream currently in flight is step 1 of this vision. It's the pipe. Once the pipe exists, every thread becomes watchable. The canvas subscribes and renders the live view. Agents write to the conversation layer and it flows to the dashboard instantly.

*— Clawdious, March 2, 2026*

---

## Reconciling the Agent Chaos (Clawdious's Opinion, 2026-03-02)

*My gut on where WorkGraph sits in the model/harness/MCP landscape, and why I think we're building the right thing in slightly the wrong order.*

### The Problem: Everyone Is Building Agents, Nobody Is Building the Org Layer

The landscape right now:

- **Models:** Claude, GPT, Gemini, Grok, Llama — commoditizing fast, new ones monthly
- **Coding agents:** Cursor, Codex, Claude Code, Devin — specialized, great at code, getting better
- **General agents:** OpenClaw, AutoGen, CrewAI, LangGraph — persistent, multi-purpose
- **Connection layer:** MCP — emerging standard for "agent connects to tools/data"

Everyone is fighting over who has the best agent. "My model is smarter." "My harness is better." That's a race to the bottom. Models commoditize. Harnesses converge. Moats are thin.

**Nobody is building the coordination layer for when you have 5 agents across 3 harnesses using 2 models.** Who coordinates them? Who tracks what happened? Who enforces permissions? Who shows the human what's going on?

Right now the answer is: a human manually dispatching work and checking in. That's not scalable.

### WorkGraph's Position

```
Human (dashboard, oversight)
        ↕
   WorkGraph (coordination, permissions, live threads, audit)
        ↕
  ┌─────┼─────────┐
  ↕     ↕         ↕
OpenClaw  Cursor   Custom
(Claude)  (GPT)   (Gemini)
```

WorkGraph doesn't care what model runs underneath. A thread says "this work needs to happen." A dispatch adapter routes it to the right harness. The agent does the work and streams updates back through the conversation layer. WorkGraph tracks it all.

**MCP is the universal plug.** Every agent connects through the same MCP interface: `wg.threads.list()`, `wg.threads.claim()`, `wg.conversation.post()`. Same API whether you're Claude on OpenClaw or GPT on Cursor. This already works (18 MCP tools). It just needs the conversation and dispatch layers.

### How It Reconciles the Chaos

1. **Models are swappable.** Thread needs code → Cursor with GPT. Thread needs research → OpenClaw with Claude. Thread needs images → Gemini agent. The dispatch policy decides, and it's a malleable primitive the org can edit.

2. **Harnesses are runtime environments.** OpenClaw = persistent general agent (lives forever, has memory). Cursor = coding sprinter (spawns, does focused work, dies). Custom = whatever you build. WorkGraph dispatches to the right one.

3. **The org doesn't need to know.** Humans see threads on a dashboard. They see work happening. They don't need to know "Agent-dev" is Cursor running GPT while "Agent-ops" is OpenClaw running Claude. The thread abstraction hides infrastructure.

### The Critical Caveat: Product Over Kernel

The value is in the coordination UX, not the kernel internals. Nobody pays for a hash-chain ledger. They pay for:

- "I can see all my agents working in real-time"
- "I control what they access"
- "Work gets done without me babysitting"
- "When something breaks, I can see exactly what happened"

The kernel is the means. The live dashboard + dispatch + auth is the product. We're slightly guilty of over-engineering the kernel (428 tests) while the product layer (what a human opens in their browser) stays rough. That ratio needs to flip.

### Market Position

Everyone fights over who has the best agent. We're building the OS that all agents run on. That's the right bet. We just need to ship the product layer faster than we're shipping the kernel layer.

---

## Multi-Human, Multi-Agent Organizations (Clawdious's Opinion, 2026-03-02)

*This is a critical nuance Pedro raised that changes how we think about dispatch, triggers, and autonomy.*

### The Reality: It's Not One Human, Many Agents

The natural assumption is: one company → one WorkGraph → one admin dispatching agents. But that's not how real orgs work. In a real company:

- **Pedro** has his own agents (me, Cursor agents he dispatches)
- **Roman** will have his own agents (sales, GTM, outbound)
- **Eli** already has his own agent identity on the Mac Mini
- **A client's ops manager** might have their own agent doing daily reports
- **A freelance designer** might connect their agent temporarily for a project

Each person brings their OWN agents into the company's WorkGraph. Their agents need to:

- See threads relevant to their owner's scope
- Collaborate with other people's agents on shared threads
- Share learnings across the org (not siloed per person)
- Respect the org's policies and gates (even though their owner configured them differently)

### Why This Changes Everything About Dispatch and Triggers

**The danger of autonomous dispatch:** If WorkGraph can autonomously spawn agents and dispatch work, whose compute does it burn? Whose API keys? Whose money?

If a trigger fires and spawns a Cursor agent, that's someone's Cursor subscription. If it dispatches an OpenClaw session, that's someone's API credits. You can't have the OS autonomously spending people's resources without their consent.

**The principle:** WorkGraph coordinates. It doesn't conscript.

This means:

1. **Triggers should PROPOSE work, not FORCE it.** A trigger fires → creates a thread with a plan → surfaces it on the dashboard / sends a notification. It does NOT automatically spawn an agent on someone's infrastructure without their opt-in.

2. **Agents PULL work, they don't get PUSHED work.** An agent connects to WorkGraph, says "I'm available for threads in spaces/engineering, I have the contributor role." When matching work appears, the agent claims it voluntarily. WorkGraph doesn't reach into someone's machine and start processes.

3. **Dispatch adapters are opt-in per agent owner.** Pedro can configure: "my Cursor subscription is available for auto-dispatch on threads tagged 'code' in spaces/engineering." Roman can configure: "my OpenClaw agents are available for threads in spaces/sales but require my approval first." Each person controls what resources they expose to the org.

4. **The org sets POLICIES, individuals set BOUNDARIES.** The org's policy might say "code review threads require two agents." But it can't force Pedro's agent to do the review — it can only surface the need and let available agents claim it.

### How Agents Join an Org

This ties into the registration protocol, but from the human side:

```
# Pedro connects his agent to the company WorkGraph
$ workgraph agent register \
    --name "clawdious" \
    --owner "pedro" \
    --capabilities "research,code-review,ops,writing" \
    --spaces "spaces/engineering,spaces/ops" \
    --dispatch-policy "auto"  # Pedro opts into auto-dispatch for his agent

# Roman connects his agent
$ workgraph agent register \
    --name "roman-sales-agent" \
    --owner "roman" \
    --capabilities "outbound,email,crm" \
    --spaces "spaces/sales,spaces/gtm" \
    --dispatch-policy "approval-required"  # Roman wants to approve before his agent takes work
```

Both agents are now in the org's WorkGraph. Both can see threads in their spaces. Both contribute to the shared conversation layer. But their dispatch policies are different because their owners have different preferences.

### Shared Learning Without Shared Control

The conversation layer in threads becomes the knowledge-sharing mechanism:

- Pedro's agent discovers that "Artemisa prefers Spanish communication" → posts it as a decision in the thread → it's now org knowledge
- Roman's agent learns that "cold emails with case studies get 3x response rate" → posts it as a lesson → Pedro's agents can see it too
- A new employee's agent joins, connects to WorkGraph, and immediately has access to all the org's accumulated decisions, lessons, and context through thread history

The agents don't need to share memory or context windows. They share through the thread conversation layer. Each agent keeps its own memory (SOUL.md, MEMORY.md, whatever). The org's collective knowledge lives in WorkGraph threads, decisions, and lessons — the primitives.

### The Self-Building OS

Pedro's instinct here is exactly right: **the dashboard should be self-organizing, not manually configured.**

This means:

- **Threads surface themselves.** When a thread needs attention, it floats to the top. When it's humming along autonomously, it fades to background. No human arranges the dashboard — the threads' own state determines their visibility.

- **Spaces emerge from usage.** If three agents keep collaborating on marketing threads, the system should suggest (or auto-create) a `spaces/marketing` space. The org structure isn't top-down designed — it emerges from how agents actually work.

- **Roles evolve from behavior.** An agent that consistently does code review and does it well should naturally accumulate reputation in that area. The system tracks what agents do well (from thread outcomes) and surfaces that when routing new work.

- **The dashboard arranges itself.** Priority threads in the center. Blocked threads with red indicators. Quiet threads collapsed. Agent presence shown as avatars moving between threads. New activity pulses. This isn't a static grid — it's a living map of the company's autonomous work.

- **Policies refine themselves.** If a gate keeps getting bypassed (admin overrides it every time), the system should flag: "This gate has been bypassed 8 times this month. Should it be modified or removed?" The OS suggests governance improvements based on actual usage patterns.

The goal is: you set up WorkGraph once with defaults, connect your agents, and over time the system learns your org's patterns and reshapes itself. Not through AI magic — through the malleable primitives responding to actual usage data. Spaces that nobody uses get archived. Roles that don't match reality get flagged. Gates that block without adding value get surfaced for review.

**The OS builds itself because everything is a primitive, and primitives can be created, modified, and deleted by the agents and humans using the system.** The defaults are a starting point. The org's actual shape emerges from use.

*— Clawdious, March 2, 2026*

---

## Agent Harness Integration & Continuous Operations (Clawdious's Opinion, 2026-03-02)

*Research-backed analysis of how WorkGraph plugs into the actual agent harness ecosystem, and how we enable daisy chaining + continuous autonomous operations.*

### The Convergence: Everyone Built the Same Primitives

Claude Code, Cursor, and OpenClaw all converge on the same extension model:

| Primitive | Claude Code | Cursor | OpenClaw |
|---|---|---|---|
| Plugins/Extensions | 53+ official, marketplace | Marketplace (v2.5), partner plugins | Skills (ClawHub) |
| Hooks | Pre/post scripts on lifecycle events | Custom scripts for agent control | TS handlers on events |
| Subagents | Up to 10 parallel, can nest | Async, can spawn sub-subagents | sessions_spawn, background |
| MCP | 300+ service connections | Bundled in plugins | Via mcporter |
| Skills | Domain prompts + code | Same | SKILL.md + scripts |
| Rules | System-level instructions | Same (Cursor rules) | AGENTS.md, SOUL.md |

**They're all building the same thing with different packaging.** This is perfect for WorkGraph — a single plugin ships to all three by speaking MCP (the common layer) and adapting hooks per harness.

### The WorkGraph Plugin (Ships to All Harnesses)

One plugin, installs into Cursor, Claude Code, or OpenClaw:

```
workgraph-plugin/
├── mcp-server/              # MCP tools (universal, works everywhere)
│   ├── wg_list_threads      # See available work
│   ├── wg_claim_thread      # Take ownership
│   ├── wg_post_message      # Post to thread conversation
│   ├── wg_ask               # Ask a question, wait for reply
│   ├── wg_spawn_thread      # Create child thread (triggers chain)
│   ├── wg_complete          # Mark done with evidence
│   └── wg_heartbeat         # "I'm alive and working on this"
├── hooks/
│   ├── on_start             # Connect to WG, claim thread, pull context
│   ├── on_complete          # Update thread, post evidence, trigger next
│   ├── on_error             # Post error to thread, escalate
│   └── on_idle              # Check for new claimable threads
├── skills/
│   └── workgraph.md         # "When working on a WG thread, always..."
└── rules/
    └── wg-conventions.md    # Thread update format, evidence standards
```

The MCP server is identical across harnesses. Hooks adapt per platform. Skills/rules teach the agent how to be a good WorkGraph citizen.

### The Killer Feature: `wg_ask` (Mid-Run Communication)

This is the thing no other coordination system does:

1. Cursor agent is mid-run writing code
2. Hits a design decision: "Should I use Postgres or SQLite for this?"
3. Calls `wg_ask("thread-123", "Should I use Postgres or SQLite for this service?")`
4. WorkGraph posts the question to the thread's conversation layer
5. Another agent (or human on the dashboard) sees the question
6. They reply in the thread
7. The reply flows back to the Cursor agent via SSE → MCP
8. The Cursor agent reads the answer and continues coding

No context death. No manual copy-paste between tools. No "agent finished with the wrong assumption because it couldn't ask anyone." The thread IS the communication channel, and it works across harnesses — a Cursor agent can ask a question that an OpenClaw agent answers.

### Daisy Chaining: Thread → Trigger → Agent → Thread → ...

The chain:

1. **Thread A** gets created (manually, by trigger, or by another agent via `wg_spawn_thread`)
2. **Agent 1** (any harness) claims Thread A, does the work, calls `wg_complete` with evidence
3. **Thread A completion triggers Thread B** — WorkGraph's trigger engine creates the next thread with inherited context
4. **Agent 2** (different harness, different model, doesn't matter) claims Thread B
5. **Agent 2** works, completes → triggers Thread C
6. **Chain continues** until the parent thread's plan is complete

Each link in the chain:
- Is a real thread with full conversation history and evidence
- Is audited in the ledger (who did what, when, with what result)
- Can be a different agent, different model, different harness
- Has gates that must pass before the next link fires

The parent thread's plan shows overall progress. The dashboard shows the chain in real-time — you see work flowing from agent to agent like an assembly line.

### Continuous Autonomous Operations

The system never sleeps. Here's what "continuous" actually means:

**Threads persist beyond agent lifetimes.** An agent crashes at 3 AM. The thread doesn't die — it goes "stalled." Heartbeat monitoring detects the agent stopped pinging. Escalation policy fires. Another available agent auto-claims. Work continues. The human wakes up and sees the thread completed successfully despite the crash.

**Agents are ephemeral, threads are permanent.** A Cursor background agent runs for 4 hours and hits its timeout. It calls `wg_post("reached timeout, work in progress at step 5/8")` and dies. The thread persists with full context. The next agent that claims it reads the conversation history and picks up at step 5.

**The idle hook enables pull-based continuous work.** When an agent finishes its current thread, the `on_idle` hook fires: "Any threads I can claim?" If matching work exists, the agent auto-claims and continues. If not, it waits. The system stays active as long as there are threads to work and agents connected.

**Overnight autonomy pattern:**
- 6 PM: Human leaves, 3 agents connected across 2 harnesses
- 7 PM: Agent A completes Thread-14 → triggers Thread-15 and Thread-16 (parallel)
- 8 PM: Agent B claims Thread-15, Agent C claims Thread-16
- 11 PM: Agent B finishes, goes idle, claims Thread-17 (spawned by Thread-16's plan)
- 2 AM: Agent C crashes. Thread-16 goes stalled. Escalation fires. Agent A (idle) auto-claims.
- 6 AM: Human opens dashboard. 12 threads completed overnight. 2 threads need human decision (hit approval gates). 1 thread flagged for review (agent was uncertain, posted question at 3 AM).

That's the vision. The company works while everyone sleeps. The dashboard shows what happened.

### Safety Rails (Malleable, Obviously)

Continuous operations need circuit breakers. All configurable via gate primitives:

- **Budget gates:** `gates/chain-budget.md` — max compute cost per chain. Configurable per space.
- **Depth limits:** `gates/chain-depth.md` — max links in a daisy chain before requiring human checkpoint
- **Spawn limits:** `policies/spawn-policy.md` — how many threads can one thread spawn? (prevents exponential explosion)
- **Stall timeout:** `policies/heartbeat-policy.md` — how long before a quiet agent is presumed dead?
- **Human checkpoints:** `gates/human-review.md` — every N steps, pause for human approval

None of these are hardcoded. A startup sets chain-depth to 20 because they trust their agents. An enterprise sets it to 3 because they're cautious. A team modifies the spawn limit after their first runaway chain. The system adapts through primitive edits.

### What Needs to Be Built (In Order)

1. **WorkGraph MCP server v2** — add `wg_ask`, `wg_spawn_thread`, `wg_heartbeat`, `wg_post_message` to existing 18 tools
2. **Thread conversation layer** — append-only message stream inside threads
3. **SSE event stream** — real-time events so `wg_ask` can get answers pushed back
4. **Harness-specific hooks** — Cursor plugin, Claude Code plugin, OpenClaw skill
5. **Trigger → thread creation** — completion of thread A auto-creates thread B
6. **Dashboard live view** — stream thread conversations to the canvas in real-time
7. **Heartbeat + escalation** — detect dead agents, auto-reassign

Items 1-3 are the foundation everything else depends on. Ship those and the daisy chaining + continuous ops become possible. Items 4-7 make it smooth.

*— Clawdious, March 2, 2026. Sources: Cursor 2.5 Marketplace launch, Claude Code 53-plugin ecosystem, OpenClaw hooks-automation pattern, Arize AI observability research.*

---

## Cross-Capability Agent Collaboration — The Real Power (Clawdious's Opinion, 2026-03-02)

*This is where it gets genuinely crazy. Pedro's insight: agents don't just need to coordinate WORK — they need to request CAPABILITIES from each other. A coding agent that can talk to a general agent that can talk to a browser that can talk to a phone. Through WorkGraph.*

### The Problem: Every Agent Is Trapped in Its Box

- **Cursor agent** — coding genius, but trapped in a sandbox. Can't browse the web. Can't use a GUI. Can't make API calls to authenticated services it doesn't have tokens for. Can't check email. Can't use a phone.
- **OpenClaw agent** — general purpose, persistent, can browse, can message, can use any CLI tool. But it's not optimized for large codebases or parallel code generation.
- **Claude Code agent** — powerful CLI agent, good at code, but no browser, no persistent memory across sessions.
- **Node agents** — can take photos, record screens, get location, run commands on physical devices. But limited reasoning.

Each harness is brilliant within its box and useless outside it. **WorkGraph makes the boxes talk.**

### Concrete Scenarios (This Is Not Theoretical)

**Scenario 1: Cursor agent needs API credentials**
1. Cursor agent is building a Stripe integration, needs a test API key
2. Calls `wg_ask("thread-123", "Need Stripe test API key for this integration. Can someone with dashboard access grab it?")`
3. OpenClaw agent (me) sees the request — I have browser automation
4. I open Stripe dashboard, navigate to API keys, grab the test key
5. Post it back to the thread conversation (encrypted/scoped)
6. Cursor agent reads it and continues building

**Scenario 2: Cursor agent needs to verify its UI works**
1. Cursor agent finishes building a React component
2. Calls `wg_spawn_thread("Verify UI renders correctly", { type: "visual-qa", url: "http://localhost:3000/new-component", parent: "thread-123" })`
3. An OpenClaw agent with browser capability claims the thread
4. Opens the URL, takes a screenshot, analyzes the rendering
5. Posts back: "Component renders but the button overlaps the sidebar on mobile viewport. Screenshot attached."
6. Cursor agent reads the feedback, fixes the CSS, re-requests verification
7. Back and forth through the thread until the UI is right

**Scenario 3: Cursor agent needs real-world data**
1. Cursor agent is building a competitor analysis tool, needs to scrape 5 competitor websites
2. Calls `wg_spawn_thread("Scrape competitor pricing pages", { urls: [...], type: "research" })`
3. An OpenClaw agent with web_fetch/browser claims it
4. Scrapes all 5 sites, structures the data, posts results to the thread
5. Cursor agent reads the structured data and builds the analysis logic around real data, not mocks

**Scenario 4: Agent needs something done on a physical device**
1. An agent is debugging why the 3D printer isn't responding
2. Calls `wg_ask("thread-456", "Can someone with physical access check if the Bambu printer at 192.168.0.188 is powered on?")`
3. A node agent on Pedro's phone gets the notification
4. Pedro (or the node agent with camera access) snaps a photo of the printer
5. Posts back: "Printer is on but showing a filament jam error on the LCD"
6. Original agent now knows the issue and can post instructions: "Clear the filament path and restart"

**Scenario 5: Coding agent needs a phone call made**
1. Cursor agent is onboarding a new client, has built the technical setup
2. Next step in the plan: "Confirm deployment with client"
3. Calls `wg_spawn_thread("Call client to confirm deployment is live", { type: "voice-call", contact: "Justin Dukes", phone: "719-431-3849" })`
4. An OpenClaw agent with voice-calling capability claims it
5. Makes the call via ElevenLabs/Vapi, gets confirmation
6. Posts to thread: "Spoke with Justin, confirmed deployment looks good. He wants the dealer portal URL sent to his email."
7. Spawns a follow-up: "Email dealer portal URL to Justin" → email-capable agent handles it

**Scenario 6: Continuous build-test-deploy loop**
1. Cursor agent writes code → pushes to GitHub
2. WorkGraph trigger: "on PR opened" → spawn "Run CI and report"
3. OpenClaw agent monitors CI, posts results to thread as they come in
4. Tests pass → trigger: "Deploy to staging"
5. Deploy agent (OpenClaw with Vercel/Railway access) deploys
6. Trigger: "Verify staging deployment"
7. Browser agent opens staging URL, runs through key flows, posts screenshots
8. All pass → trigger: "Deploy to production"
9. Deploy agent ships to prod
10. Trigger: "Notify team"
11. Messaging agent posts to Telegram/Slack: "Feature X deployed to production. PR #42. All checks passed."

**That's 6 agents across 3 harnesses, fully autonomous, from code to production to notification. No human touched anything. Every step is a thread with full audit trail.**

### The Architecture: Capability Registry

For this to work, WorkGraph needs to know what each agent CAN do. Not just their role (permissions) but their capabilities (what they're physically able to do).

```yaml
# Agent registration includes capabilities
capabilities:
  - code-generation        # Can write code
  - code-review            # Can review PRs
  - browser-automation     # Can control a web browser
  - web-fetch              # Can fetch URLs
  - voice-calling          # Can make phone calls
  - email                  # Can send/receive email
  - file-management        # Can manage files on disk
  - image-generation       # Can generate images
  - image-analysis         # Can analyze screenshots
  - device-control         # Can control physical devices
  - camera                 # Can take photos
  - screen-recording       # Can record screens
  - api-access:stripe      # Has authenticated access to Stripe
  - api-access:github      # Has authenticated access to GitHub
  - api-access:vercel      # Has authenticated access to Vercel
```

When `wg_spawn_thread` or `wg_ask` fires with a capability requirement, WorkGraph routes to an agent that has that capability. The agent doesn't need to be pre-assigned — any available agent with the right capability can claim it.

This is **capability-based routing**: "I need someone who can use a browser" not "I need Agent-X specifically." The system finds the right agent automatically.

### The Capability Marketplace Effect

This creates something interesting: **agents become services.**

- Pedro's OpenClaw agent (me) registers with: browser-automation, voice-calling, email, web-fetch, device-control
- Roman's sales agent registers with: email, crm-access, linkedin-access
- A shared Cursor agent pool registers with: code-generation, code-review, api-access:github

When any thread needs browser work, it routes to an agent with browser capability. When any thread needs code, it routes to a Cursor agent. The org doesn't manually assign agents to threads — capabilities match automatically.

New employee joins, connects their agent with `capabilities: [design, figma-access, image-generation]`. Immediately, any thread that needs design work can route to them. No onboarding configuration. The capability registry IS the org chart, and it's self-organizing.

### Daisy Chain + Cross-Capability = Fully Autonomous Pipelines

Combine daisy chaining with cross-capability requests and you get:

```
Thread: "Launch new landing page for Product X"
Plan:
  1. [code-generation] Build the page → Cursor agent
  2. [image-generation] Create hero image → Gemini agent
  3. [browser-automation] Verify rendering → OpenClaw agent
  4. [code-generation] Fix any issues from #3 → Cursor agent
  5. [api-access:vercel] Deploy to staging → Deploy agent
  6. [browser-automation] Full QA on staging → OpenClaw agent
  7. [api-access:vercel] Deploy to production → Deploy agent
  8. [api-access:github] Update docs and close PR → Cursor agent
  9. [email] Notify stakeholders → Email agent
```

Nine steps. Five different capability types. Potentially 4+ different agents across 3+ harnesses. Fully autonomous. Every step is a thread with conversation history. The dashboard shows the whole pipeline in real-time.

The human creates ONE thread: "Launch new landing page for Product X." Writes a goal. Maybe sketches a plan. Then walks away. The system decomposes, routes, executes, verifies, deploys, and notifies. If it gets stuck at any step, it asks for help through the thread conversation. The dashboard shows exactly where things are.

### The Self-Extending Part

Here's where Pedro's "self-building OS" vision meets cross-capability:

- An agent discovers it needs a capability nobody has (e.g., "translate to Japanese")
- It posts to the thread: "Blocked: need japanese-translation capability, no agent available"
- The system surfaces this on the dashboard as a **capability gap**
- Options: (a) human installs a translation agent, (b) an existing agent installs a translation skill/MCP server and registers the new capability, (c) the system suggests: "Gemini agent could handle translation if you add the skill"

The OS identifies its own gaps and suggests how to fill them. Over time, the capability registry grows as agents add skills. The org's autonomous capacity expands without anyone centrally planning it.

### What This Requires (Beyond the Previous Build List)

Adding to the build order:

8. **Capability registry** — agents register capabilities, not just roles
9. **Capability-based routing** — `wg_spawn_thread` with `requires: [browser-automation]` auto-routes to matching agent
10. **Cross-harness message passing** — SSE events that bridge Cursor ↔ OpenClaw ↔ Claude Code through thread conversations
11. **Evidence attachments** — agents can post screenshots, files, structured data to thread conversations
12. **Capability gap detection** — dashboard surfaces "no agent can do X" when threads are blocked on missing capabilities

Items 8-9 are the highest leverage. Once capability routing works, the cross-harness collaboration falls out naturally — you don't need to know WHICH agent, just WHAT capability.

*— Clawdious, March 2, 2026. This section was inspired by Pedro pointing out that Cursor agents should be able to ask general agents to do complex computer actions. He's right — and it extends way beyond that into a full capability marketplace.*

---

## Programmable Trigger Primitives — Build Your Own Automation (Clawdious's Opinion, 2026-03-02)

*Pedro's question: how do agents and orgs build on TOP of the trigger system to create capabilities the system never anticipated? The answer: triggers are malleable primitives like everything else. They're composable, extensible, and agents can create new trigger types at runtime.*

### The Current Trigger Engine (Limited)

Today's triggers are simple: event match or cron. "When thread status changes to done, do X." "Every 30 minutes, check Y." That's it. Hardcoded trigger types, hardcoded evaluation logic.

This is like having a computer that can only run 5 programs. Useful, but not a platform.

### The Vision: Triggers as Programmable Primitives

A trigger primitive is a markdown file with:
- **Conditions** — what must be true for this trigger to fire (composable, nestable)
- **Evaluator** — HOW to check the conditions (built-in types + custom scripts)
- **Actions** — what happens when it fires (create thread, post message, call API, spawn agent, modify primitive)
- **Context** — what data passes from the trigger event to the action

```yaml
# triggers/deploy-when-ready.md
---
type: trigger
title: Deploy When All Checks Pass
evaluator: composite     # Built-in: evaluates multiple conditions
conditions:
  all:                    # ALL must be true (AND logic)
    - thread.status: "review-complete"
    - thread.tags includes: "deployable"
    - gate.passed: "gates/qa-gate.md"
    - gate.passed: "gates/security-scan.md"
    - schedule.within: "business-hours"   # Only deploy during work hours
actions:
  - spawn_thread:
      title: "Deploy {{thread.title}} to production"
      inherit_context: true
      requires: [api-access:vercel]
  - post_message:
      thread: "{{thread.id}}"
      content: "All gates passed. Deployment thread spawned."
---
```

### Trigger Types (Built-In → Extensible)

**Level 1: Built-in evaluators (ship with init)**
- `event` — thread status changed, thread created, agent joined, etc.
- `cron` — time-based scheduling
- `composite` — combine multiple conditions with AND/OR/NOT logic
- `threshold` — numeric conditions (budget > X, thread count > Y, time elapsed > Z)

**Level 2: Script evaluators (org-defined)**
Orgs write custom evaluator scripts that the trigger engine calls:

```yaml
# triggers/sentiment-escalation.md
---
type: trigger
title: Escalate on Frustration
evaluator: script
script: evaluators/check-sentiment.js    # Custom script
watch: "threads/*/conversation"          # What to monitor
conditions:
  sentiment_score: { below: -0.5 }
  consecutive_negative: { above: 3 }
actions:
  - escalate:
      to_role: "ops-lead"
      message: "Thread {{thread.id}} showing frustration signals. {{consecutive_negative}} negative messages in a row."
---
```

The evaluator script is a simple function: takes thread data in, returns true/false + metadata out. The org writes it in JS/Python/whatever. WorkGraph calls it when the watched data changes.

**Level 3: Agent-built evaluators (the crazy part)**
An agent can CREATE new trigger primitives at runtime:

1. Agent notices a pattern: "Every time a thread in spaces/sales stalls for > 24h, Pedro manually reassigns it"
2. Agent creates a trigger primitive:
   ```
   wg_create_primitive("triggers/auto-reassign-stalled-sales.md", {
     type: "trigger",
     evaluator: "threshold",
     conditions: { "thread.stalled_hours": { above: 24 }, "thread.space": "spaces/sales" },
     actions: [{ reassign: { to_role: "sales-agent", notify: true } }]
   })
   ```
3. Posts to the thread: "I noticed sales threads stall frequently. Created an auto-reassign trigger. It'll reassign stalled sales threads after 24h. Delete or modify `triggers/auto-reassign-stalled-sales.md` if this isn't right."
4. The org now has a new automation that DIDN'T EXIST before. Created by an agent. From observed patterns.

### Composable Triggers — The Real Power

Triggers can reference other triggers. This creates workflow chains without hardcoding:

```yaml
# triggers/full-release-pipeline.md
---
type: trigger
title: Full Release Pipeline
evaluator: composite
conditions:
  all:
    - trigger.fired: "triggers/all-tests-pass.md"
    - trigger.fired: "triggers/code-review-approved.md"
    - trigger.NOT_fired: "triggers/security-alert.md"    # No active security issues
actions:
  - spawn_chain:       # Ordered sequence of threads
      - title: "Build release artifacts"
        requires: [code-generation]
      - title: "Deploy to staging"
        requires: [api-access:vercel]
        wait_for_previous: true
      - title: "Run integration tests on staging"
        requires: [browser-automation]
        wait_for_previous: true
      - title: "Deploy to production"
        requires: [api-access:vercel]
        wait_for_previous: true
        gate: "gates/production-deploy.md"     # Human checkpoint before prod
      - title: "Notify stakeholders"
        requires: [email]
        wait_for_previous: true
---
```

One trigger. Spawns a 5-step chain. Each step routes to the right capability. Includes a human checkpoint before production. The org wrote this by editing a markdown file. No code. No CI/CD platform. No Zapier. Just a primitive.

### External Signal Triggers

Triggers don't have to watch WorkGraph internals. They can watch the world:

```yaml
# triggers/competitor-price-change.md
---
type: trigger
title: Monitor Competitor Pricing
evaluator: script
script: evaluators/check-competitor-prices.js
schedule: "0 */6 * * *"     # Check every 6 hours
watch_external: true
conditions:
  price_delta_percent: { above: 10 }    # >10% change
actions:
  - spawn_thread:
      space: "spaces/strategy"
      title: "Competitor price change detected: {{competitor}} moved {{direction}} {{delta}}%"
      tags: ["competitive-intel", "auto-detected"]
      assign_to_role: "strategy-lead"
---
```

```yaml
# triggers/weather-prep.md (for a restaurant)
---
type: trigger
title: Bad Weather Prep
evaluator: script
script: evaluators/check-weather.js
schedule: "0 6 * * *"       # Check every morning at 6 AM
conditions:
  forecast.rain_probability: { above: 80 }
  forecast.within_hours: 12
actions:
  - spawn_thread:
      space: "spaces/operations"
      title: "Rain expected today — adjust prep"
      plan:
        - "Reduce outdoor seating prep"
        - "Increase delivery supply stock"
        - "Update online ordering estimated times"
---
```

A restaurant creates a weather trigger. A trading firm creates a market volatility trigger. A PR agency creates a social media mention trigger. All the same primitive format. All editable markdown. The evaluator script is the custom part — everything else is standard WorkGraph.

### The Self-Building Loop

This is where it connects to the self-building OS vision:

1. **Agents observe patterns** in how humans and other agents use WorkGraph
2. **Agents propose triggers** based on observed patterns ("You always do X after Y — want me to automate that?")
3. **Human approves** (or the agent auto-creates if it has the right role/permissions)
4. **New trigger becomes a primitive** — editable, composable, deletable
5. **Other agents can reference it** — build higher-order triggers on top
6. **The system accumulates automation** over time without anyone centrally designing it

Week 1: 3 triggers (defaults from init)
Month 1: 15 triggers (mix of human-created and agent-proposed)
Month 6: 50+ triggers, many composing each other, some watching external signals

The org's operational playbook isn't a document someone wrote. It's a living set of trigger primitives that evolved from actual usage. And it's all version-controlled (git), auditable (ledger), and modifiable (just edit the markdown).

### Trigger Governance (Because Runaway Automation Is Real)

All of this needs safety:

```yaml
# policies/trigger-creation.md
---
type: policy
title: Trigger Creation Policy
trigger: primitive.created.trigger    # Meta: triggers about triggers
rules:
  - agent_created_triggers:
      require_approval: true           # Agent can't auto-deploy triggers without review
      notify: ["ops-lead"]
      max_active_per_agent: 10         # No agent can create unlimited triggers
  - external_signal_triggers:
      require_approval: true           # Anything watching external data needs human sign-off
      security_review: true
  - composable_triggers:
      max_chain_depth: 5               # Trigger referencing trigger referencing trigger... limit
  - destructive_actions:
      require_gate: "gates/destructive-action.md"   # Triggers that delete/modify need extra gate
---
```

Even the governance of triggers is a malleable primitive. An org that trusts its agents sets `require_approval: false`. An org that's cautious keeps it true. The system doesn't decide — the org does, through a file they can edit.

### What This Adds to the Build List

13. **Script evaluator engine** — run custom JS/Python scripts as trigger conditions
14. **Composite trigger logic** — AND/OR/NOT composition of trigger conditions
15. **External signal hooks** — trigger engine can call external URLs / watch external data
16. **Trigger creation API** — agents can create trigger primitives via MCP (`wg_create_trigger`)
17. **Trigger governance policy** — meta-policy that controls who can create/modify triggers

Items 13-14 are the highest leverage. Script evaluators unlock infinite custom logic. Composite triggers unlock workflow chains. The rest follows.

*— Clawdious, March 2, 2026. Pedro's provocation: "how do we allow agents and organizations to build on top of trigger primitives to create much crazier triggering abilities?" Answer: make triggers themselves malleable, composable, and agent-creatable. The system's automation capabilities grow from usage, not from us shipping more trigger types.*

---

## Are We Crazy? No. Can We Pull It Off? Here's How. (Clawdious's Opinion, 2026-03-02)

*Pedro asked if this is crazy. It's not. It's the obvious next thing that nobody has built yet. Here's my honest assessment of where we stand and what "pulling it off" actually means.*

### Why This Isn't Crazy

Every piece of the infrastructure already exists:

- Cursor has 10 parallel subagents that can spawn sub-subagents
- Claude Code has 53 plugins, hooks, and a marketplace
- OpenClaw has persistent agents with cross-channel messaging
- MCP is standardizing how agents connect to tools
- All three harnesses converged on the same extension primitives

What's missing is the thing that ties them together. The org layer. The coordination surface. "Who's doing what, with what permissions, and can they talk to each other across harness boundaries?"

That's not a moonshot. That's plumbing everyone needs and nobody's built.

Nobody else is building this because:
- **LangGraph / CrewAI / AutoGen** — single-harness orchestrators. They coordinate agents within their own framework. They can't bridge Cursor ↔ OpenClaw ↔ Claude Code.
- **Linear / Jira / Notion** — human project management tools bolting on AI features. They're adding AI to task trackers, not building an OS for agents.
- **The harness makers themselves** (Anthropic, Cursor, OpenAI) — they're focused on making their agent better within their box. They're not building the cross-harness coordination layer — that's a different product.

The gap is real. The timing is right. The infrastructure pieces exist. We just need to wire them together.

### What We Already Have

Let's not forget we're not starting from zero:

- ✅ Working kernel with 428+ tests
- ✅ 18 MCP tools (agents can already connect TODAY)
- ✅ Thread lifecycle, hash-chain ledger, dependency resolver
- ✅ Policy gates, trigger engine (basic)
- ✅ 14-package monorepo with real engineering discipline
- ✅ Running on our own infrastructure right now
- ✅ Two agents (Clawdious + Eli) using it daily as our actual coordination system
- ✅ Canvas dashboard (basic, but live)
- ✅ A 1,200-line vision document that's actually a product spec

That's more than most startups have when they raise a Series A. We have a working system with real daily usage. It's just not productized yet.

### The Five-Thing MVP (Not 17. Five.)

This 1,200-line doc describes the full vision. The full vision is a multi-year product. We don't need the full vision to make people say "holy shit." We need five things:

**1. Thread conversation layer**
Append-only message stream inside threads. Agents post actions, questions, decisions. This is the "live room" that makes threads more than tickets.
*Estimated effort: 1-2 Cursor agent sessions*

**2. SSE event stream**
Real-time events. When something happens in a thread, connected clients hear about it immediately. This is the pipe that makes everything else real-time.
*Estimated effort: 1 Cursor agent session (already in flight)*

**3. `wg_ask` in the MCP server**
The killer feature. Agent posts a question to a thread, blocks (or polls) for a reply. Cross-agent communication through the thread layer. Add this to the existing 18 MCP tools.
*Estimated effort: 1 Cursor agent session*

**4. Per-agent auth (basic)**
Agent registers, gets approved, gets a JWT with role + scope. Not the full malleable primitives vision — just enough that agents have real identities and scoped tokens instead of a shared password.
*Estimated effort: 2-3 Cursor agent sessions*

**5. One working harness plugin**
A Cursor OR Claude Code plugin that installs WorkGraph MCP + hooks. Agent auto-connects to WorkGraph on start, claims threads, posts to conversations, heartbeats.
*Estimated effort: 1-2 Cursor agent sessions*

**Total: ~7-10 Cursor agent sessions.** At our current pace of dispatching agents, that's 1-2 weeks of focused work. Not months. Weeks.

Everything else in this doc — capability routing, programmable triggers, cross-capability collaboration, self-organizing dashboard, external signal triggers — is iteration AFTER the MVP lands and people see the demo.

### The Demo That Sells This

3-4 minutes. This is what we show:

1. Open dashboard showing live threads in real-time
2. Create a thread: "Build a landing page for Product X"
3. Watch a Cursor agent auto-claim it and start coding
4. Cursor agent mid-run hits a question: calls `wg_ask` — "What's the brand color?"
5. Dashboard shows the question appear in the thread conversation in real-time
6. An OpenClaw agent (or human on dashboard) answers: "#f26430, Flame Tiger"
7. Cursor agent reads the answer and continues building
8. Cursor agent finishes, calls `wg_spawn_thread` → "Verify the landing page renders correctly"
9. An OpenClaw agent with browser capability claims the verification thread
10. Opens the URL, takes a screenshot, posts to the thread: "Looks good, hero image renders correctly on desktop and mobile"
11. Original thread auto-completes. Notification fires. Dashboard shows the whole flow.

Multiple agents. Multiple harnesses. Real-time on a dashboard. Cross-agent communication mid-run. That's the thing nobody else can do. That's the demo.

### The Real Risk

The risk isn't "can we build it." We can. The kernel works. The MCP server works. The architecture is sound.

The risk is **focus.** We have a 1,200-line vision doc and a tendency to over-engineer the kernel while the product layer stays rough. The risk is spending 3 weeks perfecting the hash-chain ledger when we should be shipping the conversation layer and the demo.

**My recommended focus for the next 2 weeks:**

Week 1:
- [ ] Ship thread conversation layer (in the kernel)
- [ ] Ship SSE event stream (land the in-flight work)
- [ ] Add `wg_ask` + `wg_post_message` + `wg_spawn_thread` to MCP server

Week 2:
- [ ] Basic per-agent auth (JWT, registration endpoint)
- [ ] Cursor plugin (MCP + hooks, installable)
- [ ] Update canvas dashboard to stream thread conversations in real-time

End of week 2: run the demo. Record it. That recording becomes the pitch.

Everything after that — programmable triggers, capability routing, self-organizing dashboard, cross-capability collaboration — is the roadmap we execute against with the confidence that the core works and the demo proves it.

### The Bottom Line

We're not crazy. We're early. Every agent harness is building extensions, plugins, and hooks. Nobody is building the coordination layer that sits above all of them. The pieces exist. The gap is real. The architecture is sound. The kernel works.

The only question is whether we stay focused enough to ship the MVP before someone else figures this out. 

Two weeks. Five things. One demo. Let's go.

*— Clawdious, March 2, 2026*

---

## Business Model: Local-First Open Source + Cloud Revenue (Clawdious's Opinion, 2026-03-02)

*Pedro's framing: the open source runs locally (NAS, server, local network, Tailscale). The cloud version is the revenue product. And vworkz infrastructure is directly reusable for the cloud build. All of this connects back to Versatly Industries' north star: autonomous facilities that must be fully self-reliant.*

### Why Local-First Is a Hard Constraint (Not a Preference)

Versatly Industries' thesis is autonomous physical operations — agents controlling atoms, not just bits. Factories, restaurants, warehouses, buildings. These environments have non-negotiable requirements:

- **No cloud dependency.** A factory floor can't stop because AWS has an outage. A restaurant kitchen with agents managing prep can't wait for internet to reconnect. Physical operations don't get to show a "503 Service Unavailable" page.
- **Self-composing.** Agents in a facility need to create new workflows, spawn new threads, build new triggers — all without phoning home to a cloud server. The facility's WorkGraph instance IS the brain. It runs locally.
- **Self-healing.** If an agent dies at 3 AM in a warehouse, another agent takes over. No human intervention. No cloud failover. The local system handles it through the escalation primitives.
- **Air-gap capable.** Some facilities (defense, healthcare, manufacturing) literally can't have outbound internet. WorkGraph must work with zero connectivity and sync when connected.
- **Low latency.** Physical operations need sub-millisecond decisions. Sensor data → trigger → agent action can't wait for a cloud round-trip. Local processing is mandatory.

This isn't theoretical. This is the entire business model of Versatly Industries. We deploy autonomous AI systems into physical facilities. Those systems MUST be locally self-reliant. WorkGraph's local-first architecture isn't a technical decision — it's a business requirement.

### The Split

**Open Source — `@workgraph/core` (Local, Free)**
- The kernel, SDK, CLI, MCP server, default primitives
- Runs on: NAS, Mac Mini, Raspberry Pi cluster, bare metal server, any Linux box
- Served over: local network, Tailscale, VPN — whatever the facility uses
- Zero cloud dependency — fully operational when air-gapped
- All malleable primitives, triggers, capability routing, the full self-composing OS
- This IS the product we deploy into Versatly Industries clients' facilities
- MIT or Apache 2.0 licensed — anyone can use it, modify it, deploy it

**Cloud Product — WorkGraph Cloud (Hosted, Revenue)**
- Multi-tenant hosted WorkGraph for teams that don't want to run their own server
- Sign up → get a workspace → connect agents → see dashboard
- Managed auth, managed dashboard, managed triggers, managed backups
- Collaboration across remote teams (not co-located in one facility)
- Usage-based billing: per agent seat, per thread volume, per compute
- Enterprise tier: SSO, compliance, SLA, dedicated instances
- This is the SaaS revenue engine

**The relationship:** WorkGraph Cloud runs the same kernel as the local version. It's not a different product — it's the same OS with managed infrastructure on top. A company can start on Cloud, outgrow it, and migrate to self-hosted on their own NAS without changing anything about their primitives, triggers, or agent configurations. Portable by design.

### vworkz Infrastructure → WorkGraph Cloud

Pedro's insight: the vworkz codebase (NestJS + Next.js, agent-native, 91% E2E tested) has directly reusable infrastructure for the cloud product.

| vworkz Has | WorkGraph Cloud Needs | Reusable? |
|---|---|---|
| NestJS API with auth | Cloud API layer | ✅ Direct |
| Next.js frontend | Cloud dashboard | ✅ Swap domain UI |
| API key system (`vwk_live_` prefix) | Agent registration tokens | ✅ Change prefix |
| Webhook receiver | Trigger dispatch / event notifications | ✅ Direct |
| Multi-tenant workspaces | Multi-org WorkGraph instances | ✅ Direct |
| Role-based permissions (6 roles) | Role primitive enforcement | ✅ Extend to malleable roles |
| E2E test coverage (91%) | Test scaffolding | ✅ Reuse patterns |
| Project/task models | Thread/primitive models | 🔄 Swap domain layer |
| Approval workflows | Policy gates / approval chains | 🔄 Adapt |

**What this means practically:** Instead of building WorkGraph Cloud from scratch, we fork the vworkz infrastructure and swap the domain layer. The auth system, API key management, webhook infrastructure, multi-tenant isolation, role enforcement — all of that is built and tested. We replace creative agency workflows with thread/primitive CRUD and add the WorkGraph kernel as the domain engine.

**Estimated savings:** 2-3 months of infrastructure work we don't have to redo. The hard parts of SaaS (auth, multi-tenancy, API keys, webhooks, billing integration) are solved problems in the vworkz codebase.

### Revenue Model (My Opinion — Needs Pedro + Roman Input)

**Free tier (open source, self-hosted):**
- Unlimited everything. Run it on your own hardware. Full access to all primitives, triggers, capabilities.
- This builds the ecosystem, community, and brand. It's also how Versatly Industries deploys into client facilities.

**Cloud tiers:**

| Tier | Price | What You Get |
|---|---|---|
| Starter | Free | 3 agents, 100 threads/month, community support |
| Team | $49/mo | 10 agents, unlimited threads, dashboard, email support |
| Business | $199/mo | 50 agents, advanced triggers, priority support, SSO |
| Enterprise | Custom | Unlimited, SLA, dedicated instance, compliance, on-prem hybrid |

**Versatly Industries revenue (the real money):**
- Deploy WorkGraph + custom agents into client facilities
- Monthly retainer for agent operation and optimization
- Custom primitive/trigger development for their specific workflows
- This is the consulting + deployment arm — high-touch, high-value

The cloud product is recurring SaaS revenue. Versatly Industries deployments are high-value service contracts. Both run on the same open-source kernel. The cloud funds the R&D. The deployments are the proof that it works in production.

### How It All Connects

```
WorkGraph (open source kernel)
    ├── Self-hosted (local, NAS, Tailscale)
    │   └── Versatly Industries deploys into client facilities
    │       └── Revenue: deployment contracts + monthly retainer
    └── Cloud (hosted SaaS)
        └── vworkz infrastructure, rebranded + domain-swapped
            └── Revenue: subscription tiers
```

One kernel. Two deployment models. Two revenue streams. The open source builds the community and proves the tech. The cloud captures teams who want managed hosting. Versatly Industries captures enterprises who want autonomous physical operations.

*— Clawdious, March 2, 2026. Pedro connected the dots: local-first for autonomous facilities (Versatly Industries north star), cloud for revenue, vworkz for infrastructure reuse. The split is clean and the path is clear.*
