import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agent as agentModule,
  dispatch as dispatchModule,
  ledger as ledgerModule,
  policy as policyModule,
  store as storeModule,
  thread as threadModule,
  threadAudit as threadAuditModule,
  triggerEngine as triggerEngineModule,
  workspace as workspaceModule,
} from '@versatly/workgraph-kernel';

const agent = agentModule;
const dispatch = dispatchModule;
const ledger = ledgerModule;
const policy = policyModule;
const store = storeModule;
const thread = threadModule;
const threadAudit = threadAuditModule;
const triggerEngine = triggerEngineModule;
const workspace = workspaceModule;

let workspacePath: string;
let bootstrapToken: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-stress-full-lifecycle-'));
  const init = workspace.initWorkspace(workspacePath, { createReadme: false });
  bootstrapToken = init.bootstrapTrustToken;
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('stress: full lifecycle end-to-end', () => {
  it('runs 5 parallel end-to-end lifecycles with consistent global ledger state', { timeout: 30_000 }, async () => {
    const adminRegistration = agent.registerAgent(workspacePath, 'admin-agent', {
      token: bootstrapToken,
      capabilities: [
        'thread:create',
        'thread:update',
        'thread:claim',
        'thread:complete',
        'dispatch:run',
        'policy:manage',
      ],
    });
    expect(adminRegistration.agentName).toBe('admin-agent');

    const lifecycleCount = 5;
    const workers = Array.from({ length: lifecycleCount }, (_value, idx) => `worker-${idx}`);
    for (const workerName of workers) {
      policy.upsertParty(
        workspacePath,
        workerName,
        {
          roles: ['ops'],
          capabilities: ['thread:create', 'thread:update', 'thread:claim', 'thread:complete', 'dispatch:run'],
        },
        {
          actor: 'system',
          skipAuthorization: true,
        },
      );
      agent.heartbeat(workspacePath, workerName, {
        actor: 'system',
        capabilities: ['thread:claim', 'thread:complete', 'dispatch:run'],
      });
    }

    const lifecycleResults = await Promise.all(
      workers.map(async (workerName, idx) => {
        const createdThread = thread.createThread(
          workspacePath,
          `Lifecycle thread ${idx}`,
          `End-to-end lifecycle work item ${idx}.`,
          workerName,
        );
        store.create(
          workspacePath,
          'fact',
          {
            title: `Lifecycle audit fact ${idx}`,
            subject: 'lifecycle',
            predicate: 'state',
            object: 'pending',
            tags: ['stress', 'lifecycle'],
          },
          '# Lifecycle Audit\n',
          workerName,
          { pathOverride: `facts/lifecycle-audit-${idx}.md` },
        );
        const trigger = store.create(
          workspacePath,
          'trigger',
          {
            title: `Lifecycle trigger ${idx}`,
            status: 'active',
            condition: { type: 'event', pattern: `thread.done:${createdThread.path}` },
            action: {
              type: 'update-primitive',
              path: `facts/lifecycle-audit-${idx}.md`,
              fields: { object: `completed-${idx}` },
            },
            cooldown: 0,
          },
          '# Lifecycle Trigger\n',
          'admin-agent',
          { pathOverride: `triggers/lifecycle-${idx}.md` },
        );
        triggerEngine.runTriggerEngineCycle(workspacePath, {
          actor: workerName,
          triggerPaths: [trigger.path],
        });

        const run = dispatch.createRun(workspacePath, {
          actor: workerName,
          objective: `Dispatch lifecycle ${idx}`,
          context: { lifecycle: idx },
        });
        dispatch.markRun(workspacePath, run.id, workerName, 'running');
        dispatch.markRun(workspacePath, run.id, workerName, 'succeeded', {
          output: `dispatched-${idx}`,
          contextPatch: { lifecycle_completed: true },
        });

        thread.claim(workspacePath, createdThread.path, workerName);
        thread.done(
          workspacePath,
          createdThread.path,
          workerName,
          `Completed lifecycle ${idx} https://github.com/versatly/workgraph/pull/${1_000 + idx}`,
          {
            evidence: [
              `https://github.com/versatly/workgraph/pull/${1_000 + idx}`,
            ],
          },
        );

        const triggerCycle = triggerEngine.runTriggerEngineCycle(workspacePath, {
          actor: workerName,
          triggerPaths: [trigger.path],
        });
        expect(triggerCycle.fired).toBe(1);

        const auditTrail = dispatch.auditTrail(workspacePath, run.id);
        expect(auditTrail.length).toBeGreaterThan(0);

        const threadHistoryOps = ledger.historyOf(workspacePath, createdThread.path).map((entry) => entry.op);
        expect(threadHistoryOps).toContain('create');
        expect(threadHistoryOps).toContain('claim');
        expect(threadHistoryOps).toContain('done');

        return {
          workerName,
          runId: run.id,
          threadPath: createdThread.path,
          triggerPath: trigger.path,
        };
      }),
    );

    expect(lifecycleResults).toHaveLength(lifecycleCount);

    const verify = ledger.verifyHashChain(workspacePath, { strict: true });
    expect(verify.ok).toBe(true);
    expect(verify.issues).toEqual([]);

    const doneEntries = ledger.query(workspacePath, { op: 'done', type: 'thread' });
    expect(doneEntries.length).toBeGreaterThanOrEqual(lifecycleCount);

    for (const result of lifecycleResults) {
      const finalThread = store.read(workspacePath, result.threadPath);
      expect(finalThread?.fields.status).toBe('done');

      const auditFact = store.read(
        workspacePath,
        `facts/lifecycle-audit-${result.workerName.replace('worker-', '')}.md`,
      );
      expect(auditFact?.fields.object).toContain('completed');
    }

    const auditReport = threadAudit.reconcileThreadState(workspacePath);
    const criticalAuditIssues = auditReport.issues.filter((issue) =>
      issue.kind === 'active_without_claim'
      || issue.kind === 'active_owner_mismatch'
      || issue.kind === 'claim_without_active_status'
      || issue.kind === 'active_without_lease'
      || issue.kind === 'stale_lease'
    );
    expect(criticalAuditIssues).toEqual([]);
  });
});
