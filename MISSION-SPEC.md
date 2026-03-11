# Mission Primitive — Design Spec

## Inspiration
Factory.ai Missions: structured planning → milestone decomposition → parallel agent dispatch → milestone validation → human-as-PM orchestration.

## What WorkGraph Already Has
- `thread` — tasks with status, claims, deps, parent, space, policy gates
- `project` — grouping container
- `dispatch` — runtime adapter dispatch (Cursor, Claude Code, shell)
- `trigger` — event-driven automation
- `policy` / `policy-gate` — governance checkpoints
- `run` — execution records
- `ledger` — full audit trail
- Threads already support `parent` field for hierarchy

## New Primitives

### `mission`
A mission is a high-level goal decomposed into milestones and features. It's the orchestration container.

```yaml
---
primitive: mission
mid: deploy-clawvault-cloud
title: Deploy ClawVault Cloud to Production
description: >-
  Full production deployment of ClawVault Cloud — NestJS backend + Next.js frontend
  on Railway, with Neon DB, auth, and org management.
status: planning  # planning → approved → active → validating → completed → failed
priority: high
owner: clawdious
project: projects/clawvault.md
space: spaces/infrastructure.md

# Planning phase output
plan:
  goal: "Production-ready ClawVault Cloud with decision traces, org management, auth"
  constraints:
    - "Use Railway for deployment"
    - "Neon DB for Postgres"
    - "Must support multi-org from day 1"
  estimated_runs: 12  # features + 2*milestones
  estimated_cost_usd: null  # filled after dispatch

milestones:
  - id: ms-1
    title: "Core API + DB"
    status: open  # open → active → validating → passed → failed
    features:
      - threads/mission-deploy-clawvault-cloud/prisma-schema.md
      - threads/mission-deploy-clawvault-cloud/api-endpoints.md
      - threads/mission-deploy-clawvault-cloud/auth-system.md
    validation:
      strategy: automated  # automated | manual | hybrid
      criteria:
        - "npm run build succeeds"
        - "npm test passes"
        - "prisma migrate deploys cleanly"
  - id: ms-2
    title: "Frontend + Deploy"
    status: open
    deps: [ms-1]
    features:
      - threads/mission-deploy-clawvault-cloud/next-frontend.md
      - threads/mission-deploy-clawvault-cloud/railway-deploy.md
    validation:
      strategy: hybrid
      criteria:
        - "Site loads at production URL"
        - "Auth flow works end-to-end"

# Execution tracking
started_at: null
completed_at: null
total_runs: 0
total_cost_usd: 0

tags: [clawvault-cloud, deployment, mission]
created: 2026-03-09T21:00:00Z
updated: 2026-03-09T21:00:00Z
---

## Goal
Production-ready ClawVault Cloud with decision traces, org management, auth.
```

### `milestone` (embedded in mission, not a separate primitive)
Milestones are embedded in the mission YAML as structured objects. They reference threads (features) that must complete before validation runs.

### Feature threads
Feature threads are regular `thread` primitives with a `parent` pointing to the mission. They get auto-created during mission planning and live in a mission-namespaced directory.

```
threads/mission-{mid}/
  feature-1.md
  feature-2.md
  ...
```

## Mission Lifecycle

### 1. Planning Phase (`status: planning`)
```
mission create "Deploy ClawVault Cloud" --project clawvault
```
Creates mission in `planning` status. The orchestrator (me or an agent) then:
- Iterates on the goal, constraints, approach
- Decomposes into milestones with features
- Assigns estimated_runs
- Creates feature threads (as `open` threads with `parent: missions/{mid}.md`)

### 2. Approval (`status: approved`)
```
mission approve {mid}
```
Human or policy gate approves the plan. Transitions to `approved`.

### 3. Execution (`status: active`)
```
mission start {mid}
```
Begins execution:
- First milestone activates
- Feature threads get dispatched to agents (Cursor, Claude Code, etc.)
- Each dispatch creates a `run` primitive linked to the thread
- As threads complete, milestone progress updates

### 4. Milestone Validation (`milestone.status: validating`)
When all features in a milestone are done:
- Validation worker runs (automated: `npm test`, manual: human review, hybrid: both)
- If passed → milestone.status = `passed`, next milestone activates
- If failed → creates fix-threads, re-runs failing features

### 5. Completion (`status: completed`)
All milestones passed. Mission done. Ledger records full history.

## Kernel Changes

### New files:
- `packages/kernel/src/mission.ts` — Mission CRUD, lifecycle, milestone management
- `packages/kernel/src/mission-orchestrator.ts` — Auto-dispatch, validation, progress tracking
- `packages/kernel/src/mission.test.ts`
- `packages/kernel/src/mission-orchestrator.test.ts`

### Changes to existing:
- `packages/kernel/src/types.ts` — Add MissionStatus, MilestoneStatus, Mission types
- `packages/kernel/src/store.ts` — Register `mission` primitive type
- `packages/mcp-server/src/mcp/tools/read-tools.ts` and `packages/mcp-server/src/mcp/tools/write-tools.ts` — MCP mission read/write tool registration
- `packages/cli/` — Add `workgraph mission` subcommand group

### MCP Tools:
- `workgraph_create_mission` — Create mission with initial goal
- `workgraph_plan_mission` — Add/update milestones and features
- `workgraph_approve_mission` — Approve plan, transition to approved
- `workgraph_start_mission` — Begin execution
- `workgraph_mission_status` — Get mission status with milestone progress
- `workgraph_mission_progress` — Detailed progress: features done/total per milestone, runs, costs
- `workgraph_intervene_mission` — Redirect, re-plan, skip feature, change priority

### CLI Commands:
```bash
workgraph mission create "title" --project X --goal "..."
workgraph mission plan {mid} --add-milestone "Core API" --features "prisma,api,auth"
workgraph mission approve {mid}
workgraph mission start {mid}
workgraph mission status {mid}
workgraph mission list [--active] [--project X]
workgraph mission intervene {mid} --skip-feature {tid} --reason "..."
```

## Auto-Dispatch Logic (mission-orchestrator.ts)

When a mission is `active`:
1. Find the next milestone that is `open` and whose deps are all `passed`
2. Activate that milestone
3. For each feature thread in the milestone:
   - If thread is `open` and not claimed → dispatch to appropriate adapter
   - Adapter selection: check thread tags for hints (`cursor`, `claude-code`, `manual`)
   - Default: `cursor-cloud` adapter
4. When all features in milestone are `done` → run validation
5. On validation pass → advance to next milestone
6. On all milestones passed → complete mission

## Validation Workers

Validation runs are dispatches with a special `validation` flag:
```typescript
dispatch.create(workspacePath, {
  actor: 'mission-orchestrator',
  adapter: 'cursor-cloud',
  objective: `Validate milestone "${milestone.title}": ${milestone.validation.criteria.join('; ')}`,
  context: { missionId: mid, milestoneId: milestone.id, isValidation: true }
});
```

If validation fails, orchestrator creates fix-threads:
```typescript
thread.createThread(workspacePath, `Fix: ${failureDescription}`, failureGoal, 'mission-orchestrator', {
  parent: `missions/${mid}.md`,
  tags: ['fix', 'validation-failure']
});
```

## Cost Tracking

Each dispatch run records cost (from adapter response). Mission aggregates:
```yaml
total_runs: 8
total_cost_usd: 12.50
runs_by_adapter:
  cursor-cloud: 6
  claude-code: 2
```

## Integration with Existing Systems

### Triggers
- `mission-milestone-complete` — fires when milestone passes
- `mission-feature-dispatched` — fires when feature thread gets dispatched
- `mission-completed` — fires when all milestones pass
- `mission-validation-failed` — fires when validation fails

### Policy Gates
Missions can require approval gates:
- `mission-plan-approval` — plan must be approved before execution
- `mission-deploy-approval` — deployment milestones need explicit approval

### Webhooks
Mission events flow through the webhook gateway, so external systems can react.

## NOT in Scope (v1)
- Parallel feature execution within a milestone (sequential for v1, parallel later)
- Skill auto-development (Factory does this, we skip for now)
- Cost estimation pre-dispatch (just track actuals)
- Web UI (use MCP/CLI for now)
