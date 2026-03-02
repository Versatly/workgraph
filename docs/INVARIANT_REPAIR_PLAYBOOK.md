# WorkGraph Invariant Repair Playbook

This runbook is for **live workspace drift** and should be executed when health checks, agents, or automation report inconsistencies.

Scope:

- ledger/thread state mismatches
- stale claims/runs
- graph hygiene degradation
- registry/reference drift

This playbook is intentionally explicit so operators can execute deterministic repair steps and produce auditable evidence.

## 1) Invariants to protect

Treat the following as hard invariants for operational correctness:

1. **Ledger/thread reconciliation is clean**
   - `workgraph ledger reconcile` (via MCP: `workgraph_ledger_reconcile`) reports `ok=true` and zero issues.
2. **No stale ownership state**
   - stale claims/runs are absent or explicitly repaired with traceable events.
3. **Reference graph is structurally sound**
   - no broken wiki-links; orphan growth is monitored and explained.
4. **Policy transitions remain enforceable**
   - policy parties/capabilities exist for sensitive promotions.

## 2) Baseline triage sequence (read-only)

Run these first and capture output before making repairs:

```bash
workgraph status -w <workspace> --json
workgraph doctor -w <workspace> --json
workgraph graph hygiene -w <workspace> --json
workgraph ledger verify -w <workspace> --strict --json
workgraph replay -w <workspace> --json
```

MCP equivalents for automation:

- `workgraph_status`
- `workgraph_ledger_reconcile`
- `workgraph_graph_hygiene`
- `workgraph_ledger_recent`

## 3) Severity and response

Use this severity matrix to avoid over/under-repair:

- **SEV-1 (critical):** ledger verify failure, hash-chain break, or irreconcilable thread ownership conflict.
  - Freeze write automation.
  - Gather replay evidence.
  - Repair only with explicit operator approval and post-repair verification.
- **SEV-2 (high):** stale claims/runs that block flow, registry drift, or repeated reconcile issues.
  - Run safe auto-fixes where available.
  - Reconcile and verify immediately after.
- **SEV-3 (medium):** graph hygiene degradation (orphans/broken links) without execution impact.
  - Schedule targeted cleanup in maintenance window.
- **SEV-4 (low):** expected empty directories and non-blocking warnings.
  - Track trend; no emergency action required.

## 4) Repair procedure (safe-first)

### Step A: Auto-repair safe issues

```bash
workgraph doctor -w <workspace> --fix --actor <operator> --json
```

This is safe for:

- orphan wiki-link cleanup
- stale claim releases
- stale run cancellations

### Step B: Reconcile and seal state

```bash
workgraph dispatch reconcile -w <workspace> --actor <operator> --json
workgraph ledger seal -w <workspace> --json
workgraph doctor -w <workspace> --json
workgraph graph hygiene -w <workspace> --json
```

### Step C: Validate invariants post-fix

Re-run triage checks and require:

- `doctor.ok === true`
- `ledger_reconcile.ok === true` with no issues
- `graph_hygiene.brokenLinkCount === 0`
- `ledger verify --strict` passes

If any check remains red, escalate to manual forensic replay before additional mutations.

## 5) Manual forensic pass (when auto-fix is insufficient)

1. Replay suspicious time window:
   ```bash
   workgraph replay -w <workspace> --since <iso> --until <iso> --json
   ```
2. Inspect run transitions and ownership events:
   ```bash
   workgraph dispatch list -w <workspace> --json
   workgraph ledger query -w <workspace> --op transition --json
   ```
3. Repair specific primitives with explicit actor attribution only after confirming causal chain.

## 6) Operational cadence

Recommended cadence for active multi-agent workspaces:

- Every dispatch cycle (or every 15 minutes): `status`, `ledger_reconcile`, `graph_hygiene`
- Hourly: `doctor --json`
- Daily: `doctor --fix` during low-traffic window + post-fix verification

## 7) Evidence requirements for incident closure

For every invariant-repair incident, archive:

1. pre-fix triage outputs
2. exact repair commands run
3. post-fix verification outputs
4. decision notes (why repair path chosen)

Store evidence in workspace checkpoints or incident primitives for durable auditability.
