# OBJ-09: Signature Multi-Agent Showcase

This showcase demonstrates a full WorkGraph collaboration lifecycle with three agents:

- `governance-admin` (governance + approvals)
- `agent-intake` (triage + routing)
- `agent-builder` (implementation)
- `agent-reviewer` (self-assembly + QA closure)

The flow is intentionally end-to-end and reproducible from a fresh workspace. Every WorkGraph CLI invocation uses `--json`.

## What this demonstrates

1. **Agent registration and governance**
   - Bootstrap admin registration
   - Approval-based registration requests for agents
   - Credential issuance and heartbeat publication

2. **Thread lifecycle and plan-step coordination**
   - Multi-thread objective decomposition
   - Conversation and plan-step creation
   - Claim/start/progress/done transitions across multiple actors

3. **Self-assembly**
   - Capability advertisement + requirements matching
   - `assembleAgent()` claims the next suitable thread
   - Existing plan-step is automatically activated for the assembled agent

4. **Trigger -> run -> evidence loop**
   - Trigger creation with a structured `dispatch-run` action
   - Trigger engine cycle executes runs automatically
   - Dispatch run evidence chain is validated from CLI output
   - Ledger hash-chain integrity is verified

## Run it

From repo root:

```bash
bash examples/multi-agent-showcase/run.sh --json
```

Optional arguments:

- `--workspace <path>`: use a specific workspace directory
- `--skip-build`: skip `pnpm run build` (useful in tests)
- `--json`: emit machine-readable summary only

## Script breakdown

- `scripts/01-governance.mjs`
  - Initializes workspace
  - Registers `governance-admin` with bootstrap token
  - Runs request/review approval flow for all collaborating agents
  - Outputs issued API keys and governance snapshot

- `scripts/02-collaboration.mjs`
  - Creates threads, conversation, and plan-steps
  - Drives intake + builder thread lifecycle transitions
  - Runs self-assembly for reviewer via SDK
  - Completes reviewer plan-step and closes conversation

- `scripts/03-trigger-loop.mjs`
  - Creates active trigger via SDK with `dispatch-run` action
  - Executes trigger engine loop with run execution
  - Validates run status/evidence and ledger integrity

- `scripts/run-showcase.mjs`
  - Orchestrates all phases
  - Collects rollup metrics and boolean capability checks
  - Returns one final JSON report

## Expected outcome

The final JSON output contains:

- `checks.governance`
- `checks.selfAssemblyClaimedReviewerThread`
- `checks.planStepCoordinated`
- `checks.triggerRunEvidence`
- `checks.ledgerActivity`

When all checks are `true`, the showcase has completed successfully.
