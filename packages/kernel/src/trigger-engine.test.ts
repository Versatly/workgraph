import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import * as registry from './registry.js';
import * as ledger from './ledger.js';
import * as safety from './safety.js';
import * as store from './store.js';
import * as thread from './thread.js';
import * as transport from './transport/index.js';
import * as triggerEngine from './trigger-engine.js';

let workspacePath: string;

interface WebhookTestServer {
  url: string;
  stop: () => Promise<void>;
}

type WebhookServerProcess = ReturnType<typeof spawn>;

async function startWebhookTestServer(mode: 'success' | 'failure'): Promise<WebhookTestServer> {
  const serverScript = `
const http = require('node:http');
const mode = process.env.WG_WEBHOOK_TEST_MODE;
const server = http.createServer((request, response) => {
  if (mode === 'failure') {
    response.statusCode = 503;
    response.end('service unavailable');
    return;
  }

  const chunks = [];
  request.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  request.on('end', () => {
    response.statusCode = 202;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      method: request.method,
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf-8'),
    }));
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') {
    process.stderr.write('failed to bind webhook test server');
    process.exit(1);
    return;
  }
  process.stdout.write(String(address.port) + '\\n');
});
`;
  const child = spawn(process.execPath, ['-e', serverScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WG_WEBHOOK_TEST_MODE: mode,
    },
  });
  const port = await waitForWebhookServerPort(child, mode);
  return {
    url: `http://127.0.0.1:${port}/agent-ingest`,
    stop: async () => stopWebhookServer(child),
  };
}

function waitForWebhookServerPort(
  child: WebhookServerProcess,
  mode: 'success' | 'failure',
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${mode} webhook test server startup.`));
    }, 5_000);
    let stdout = '';
    let stderr = '';
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      clearTimeout(timeout);
      reject(new Error(`Webhook test server missing stdio streams for ${mode} mode.`));
      return;
    }

    const onData = (chunk: Buffer | string) => {
      stdout += chunk.toString();
      const firstLine = stdout.split('\n')[0]?.trim() ?? '';
      const parsed = Number(firstLine);
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      clearTimeout(timeout);
      stdoutStream.off('data', onData);
      stderrStream.off('data', onError);
      resolve(parsed);
    };
    const onError = (chunk: Buffer | string) => {
      stderr += chunk.toString();
    };

    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Webhook test server exited early with code ${code ?? 'unknown'}: ${stderr}`));
    });
    stdoutStream.on('data', onData);
    stderrStream.on('data', onError);
  });
}

function stopWebhookServer(child: WebhookServerProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
    }, 1_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-trigger-engine-'));
  registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('trigger engine', () => {
  it.skip('executes update-primitive and shell trigger actions (flaky in CI)', () => {
    const targetFact = store.create(workspacePath, 'fact', {
      title: 'Target fact',
      subject: 'system',
      predicate: 'state',
      object: 'initial',
      tags: ['ops'],
    }, '# Fact\n', 'agent-fact', { pathOverride: 'facts/target-fact.md' });

    store.create(workspacePath, 'trigger', {
      title: 'Update target fact when facts change',
      status: 'active',
      condition: { type: 'file-watch', glob: 'facts/**/*.md' },
      action: {
        type: 'update-primitive',
        path: targetFact.path,
        fields: { object: 'updated-by-trigger' },
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    store.create(workspacePath, 'trigger', {
      title: 'Emit shell marker when facts change',
      status: 'active',
      condition: { type: 'file-watch', glob: 'facts/**/*.md' },
      action: {
        type: 'shell',
        command: 'echo shell-fired > .workgraph/shell-trigger.txt',
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    const initCycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(initCycle.fired).toBe(0);

    store.create(workspacePath, 'fact', {
      title: 'Changed fact',
      subject: 'system',
      predicate: 'state',
      object: 'changed',
      tags: ['ops'],
    }, '# Fact\n', 'agent-fact', { pathOverride: 'facts/changed-fact.md' });

    const fireCycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(fireCycle.fired).toBe(2);
    expect(store.read(workspacePath, targetFact.path)?.fields.object).toBe('updated-by-trigger');

    const shellMarker = path.join(workspacePath, '.workgraph', 'shell-trigger.txt');
    expect(fs.existsSync(shellMarker)).toBe(true);
    expect(fs.readFileSync(shellMarker, 'utf-8')).toContain('shell-fired');
  });

  it('evaluates active triggers, respects cooldown, and persists state', () => {
    const triggerPrimitive = store.create(workspacePath, 'trigger', {
      title: 'Follow-up on done threads',
      status: 'active',
      condition: { type: 'event', event: 'thread-complete' },
      action: {
        type: 'create-thread',
        title: 'Follow-up {{matched_event_latest_target}}',
        goal: 'Investigate completed work outputs',
        tags: ['follow-up'],
      },
      cooldown: 120,
    }, '# Trigger\n', 'system');

    const initCycle = triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'system',
    });
    expect(initCycle.fired).toBe(0);

    const seededThread = thread.createThread(workspacePath, 'Implement parser', 'Ship parser MVP', 'agent-dev');
    thread.claim(workspacePath, seededThread.path, 'agent-dev');
    thread.done(workspacePath, seededThread.path, 'agent-dev', 'Parser complete https://github.com/versatly/workgraph/pull/11');

    const fireCycle = triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'system',
    });
    expect(fireCycle.fired).toBe(1);
    const createdThreads = store.list(workspacePath, 'thread');
    expect(createdThreads.some((entry) => String(entry.fields.title).startsWith('Follow-up'))).toBe(true);

    const cooldownCycle = triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'system',
    });
    expect(cooldownCycle.fired).toBe(0);
    const triggerResult = cooldownCycle.triggers.find((entry) => entry.triggerPath === triggerPrimitive.path);
    expect(triggerResult?.runtimeState).toBe('cooldown');

    const statePath = triggerEngine.triggerStatePath(workspacePath);
    expect(fs.existsSync(statePath)).toBe(true);
    const state = triggerEngine.loadTriggerState(workspacePath);
    expect(state.triggers[triggerPrimitive.path]?.fireCount).toBe(1);
    expect(state.triggers[triggerPrimitive.path]?.cooldownUntil).toBeDefined();
  });

  it('records trigger action deliveries in the transport outbox', () => {
    store.create(workspacePath, 'trigger', {
      title: 'Transported trigger action',
      status: 'active',
      condition: { type: 'event', event: 'thread-complete' },
      action: {
        type: 'create-thread',
        title: 'Transport follow-up {{matched_event_latest_target}}',
        goal: 'Verify transport outbox trigger delivery',
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    const seededThread = thread.createThread(workspacePath, 'Transport source', 'Ship transport source', 'agent-dev');
    thread.claim(workspacePath, seededThread.path, 'agent-dev');
    thread.done(workspacePath, seededThread.path, 'agent-dev', 'Transport source done https://github.com/versatly/workgraph/pull/88');

    const first = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(first.fired).toBe(0);

    const nextThread = thread.createThread(workspacePath, 'Transport source 2', 'Ship transport source 2', 'agent-dev');
    thread.claim(workspacePath, nextThread.path, 'agent-dev');
    thread.done(workspacePath, nextThread.path, 'agent-dev', 'Transport source 2 done https://github.com/versatly/workgraph/pull/89');

    const second = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(second.fired).toBe(1);

    const outbox = transport.listTransportOutbox(workspacePath)
      .filter((record) => record.deliveryHandler === 'trigger-action');
    expect(outbox.length).toBeGreaterThanOrEqual(1);
    expect(outbox[0]?.status).toBe('delivered');
    expect(outbox[0]?.envelope.topic).toBe('create-thread');
  });

  it('matches event trigger patterns against ledger events', () => {
    const patternTrigger = store.create(workspacePath, 'trigger', {
      title: 'Pattern match done events',
      type: 'event',
      enabled: true,
      status: 'active',
      condition: { type: 'event', pattern: 'thread.*' },
      action: {
        type: 'create-thread',
        title: 'Pattern follow-up {{matched_event_latest_target}}',
        goal: 'Validate wildcard pattern matching',
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    const seed = thread.createThread(workspacePath, 'Pattern source', 'Complete source thread', 'agent-pattern');
    thread.claim(workspacePath, seed.path, 'agent-pattern');
    thread.done(workspacePath, seed.path, 'agent-pattern', 'Done https://github.com/versatly/workgraph/pull/33');

    const first = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(first.fired).toBe(0);

    const another = thread.createThread(workspacePath, 'Pattern source 2', 'Second completion', 'agent-pattern');
    thread.claim(workspacePath, another.path, 'agent-pattern');
    thread.done(workspacePath, another.path, 'agent-pattern', 'Done https://github.com/versatly/workgraph/pull/34');

    const second = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(second.fired).toBe(1);
    const triggerResult = second.triggers.find((entry) => entry.triggerPath === patternTrigger.path);
    expect(triggerResult?.reason).toContain('Matched');
    expect(store.list(workspacePath, 'thread').some((entry) =>
      String(entry.fields.title).startsWith('Pattern follow-up'))
    ).toBe(true);
  });

  it('does not auto-fire manual triggers during engine cycles', () => {
    const manualTrigger = store.create(workspacePath, 'trigger', {
      title: 'Manual only trigger',
      type: 'manual',
      enabled: true,
      status: 'active',
      condition: { type: 'manual' },
      action: {
        type: 'dispatch-run',
        objective: 'Manual fire required',
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    const cycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(cycle.fired).toBe(0);
    const result = cycle.triggers.find((entry) => entry.triggerPath === manualTrigger.path);
    expect(result?.fired).toBe(false);
    expect(result?.reason).toContain('Manual trigger condition requires explicit');
  });

  it('supports composite any/all trigger conditions', () => {
    store.create(workspacePath, 'trigger', {
      title: 'Any composite trigger',
      status: 'active',
      condition: {
        type: 'any',
        conditions: [
          { type: 'manual' },
          {
            type: 'all',
            conditions: [
              { type: 'event', pattern: 'thread.*' },
              { type: 'not', condition: { type: 'manual' } },
            ],
          },
        ],
      },
      action: {
        type: 'create-thread',
        title: 'Any composite {{matched_event_latest_target}}',
        goal: 'Created by any composite trigger',
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    store.create(workspacePath, 'trigger', {
      title: 'All composite trigger',
      status: 'active',
      condition: {
        type: 'all',
        conditions: [
          { type: 'event', pattern: 'thread.*' },
          { type: 'not', condition: { type: 'manual' } },
        ],
      },
      action: {
        type: 'create-thread',
        title: 'All composite {{matched_event_latest_target}}',
        goal: 'Created by all composite trigger',
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    const initCycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(initCycle.fired).toBe(0);

    const sourceThread = thread.createThread(workspacePath, 'Composite source', 'Drive composite conditions', 'agent-composite');
    thread.claim(workspacePath, sourceThread.path, 'agent-composite');
    thread.done(workspacePath, sourceThread.path, 'agent-composite', 'Composite done https://github.com/versatly/workgraph/pull/44');

    const fireCycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(fireCycle.fired).toBe(2);
    expect(store.list(workspacePath, 'thread').some((entry) =>
      String(entry.fields.title).startsWith('Any composite'))
    ).toBe(true);
    expect(store.list(workspacePath, 'thread').some((entry) =>
      String(entry.fields.title).startsWith('All composite'))
    ).toBe(true);
  });

  it('fires cascade triggers immediately when thread reaches done state', () => {
    const cascadeTrigger = store.create(workspacePath, 'trigger', {
      title: 'Cascade on completion',
      status: 'active',
      condition: { type: 'thread-complete' },
      cascade_on: ['thread-complete'],
      action: {
        type: 'create-thread',
        title: 'Cascade from {{completed_thread_path}}',
        goal: 'Run follow-up thread generated via cascade',
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    const sourceThread = thread.createThread(workspacePath, 'Source thread', 'Complete source', 'agent-owner');
    thread.claim(workspacePath, sourceThread.path, 'agent-owner');
    thread.done(workspacePath, sourceThread.path, 'agent-owner', 'Source complete https://github.com/versatly/workgraph/pull/12');

    const threads = store.list(workspacePath, 'thread');
    expect(threads).toHaveLength(2);
    expect(threads.some((entry) => String(entry.fields.title).startsWith('Cascade from'))).toBe(true);

    const state = triggerEngine.loadTriggerState(workspacePath);
    expect(state.triggers[cascadeTrigger.path]?.fireCount).toBe(1);
  });

  it('blocks risky trigger actions when safety rails are engaged', () => {
    safety.pauseSafetyOperations(workspacePath, 'system', 'Pause risky trigger actions');
    store.create(workspacePath, 'trigger', {
      title: 'Blocked shell cascade',
      status: 'active',
      condition: { type: 'thread-complete' },
      cascade_on: ['thread-complete'],
      action: {
        type: 'shell',
        command: 'node -e "require(\'node:fs\').writeFileSync(\'.workgraph/shell-trigger.txt\', \'shell-fired\')"',
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    const sourceThread = thread.createThread(workspacePath, 'Safety source', 'Trip safety rails', 'agent-safety');
    thread.claim(workspacePath, sourceThread.path, 'agent-safety');
    thread.done(workspacePath, sourceThread.path, 'agent-safety', 'Safety done https://github.com/versatly/workgraph/pull/55');

    const shellMarker = path.join(workspacePath, '.workgraph', 'shell-trigger.txt');
    expect(fs.existsSync(shellMarker)).toBe(false);

    const state = triggerEngine.loadTriggerState(workspacePath);
    const blockedTriggerPath = 'triggers/blocked-shell-cascade.md';
    expect(state.triggers[blockedTriggerPath]?.fireCount ?? 0).toBe(0);
    expect(state.triggers[blockedTriggerPath]?.lastError).toContain('Safety rails blocked');
  });

  it('uses ledger offset cursors so same-timestamp events are not skipped', () => {
    vi.useFakeTimers();
    try {
      const frozenNow = new Date('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(frozenNow);

      const eventTrigger = store.create(workspacePath, 'trigger', {
        title: 'Follow-up on every completed thread',
        status: 'active',
        condition: { type: 'event', event: 'thread-complete' },
        action: {
          type: 'create-thread',
          title: 'Offset follow-up {{matched_event_latest_target}}',
          goal: 'Verify event cursor offset handling',
          tags: ['offset-cursor'],
        },
        cooldown: 0,
      }, '# Trigger\n', 'system');

      const firstThread = thread.createThread(workspacePath, 'Seed completion', 'Initial completion event', 'agent-seed');
      thread.claim(workspacePath, firstThread.path, 'agent-seed');
      thread.done(workspacePath, firstThread.path, 'agent-seed', 'Seed completed https://github.com/versatly/workgraph/pull/13');

      const firstCycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system', now: frozenNow });
      expect(firstCycle.fired).toBe(0);
      const firstState = triggerEngine.loadTriggerState(workspacePath);
      const firstOffset = firstState.triggers[eventTrigger.path]?.lastEventCursorOffset;
      expect(typeof firstOffset).toBe('number');
      expect((firstOffset ?? 0) > 0).toBe(true);

      const secondThread = thread.createThread(workspacePath, 'Same-ts completion', 'Second completion at identical timestamp', 'agent-seed');
      thread.claim(workspacePath, secondThread.path, 'agent-seed');
      thread.done(workspacePath, secondThread.path, 'agent-seed', 'Second completed https://github.com/versatly/workgraph/pull/14');

      const secondCycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system', now: frozenNow });
      expect(secondCycle.fired).toBe(1);
      expect(store.list(workspacePath, 'thread').some((entry) =>
        String(entry.fields.title).startsWith('Offset follow-up'))
      ).toBe(true);

      const secondState = triggerEngine.loadTriggerState(workspacePath);
      const secondOffset = secondState.triggers[eventTrigger.path]?.lastEventCursorOffset;
      expect((secondOffset ?? 0) > (firstOffset ?? 0)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-synthesis trigger fires when threshold of new tagged facts is met', () => {
    const synthesis = triggerEngine.addSynthesisTrigger(workspacePath, {
      tagPattern: 'research-*',
      threshold: 2,
      actor: 'agent-synth',
    });

    const initCycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(initCycle.fired).toBe(0);
    const initialState = triggerEngine.loadTriggerState(workspacePath);
    const cursorTs = initialState.triggers[synthesis.trigger.path]?.synthesisCursorTs;
    expect(cursorTs).toBeDefined();
    const cursorMs = Date.parse(String(cursorTs));

    const factA = store.create(workspacePath, 'fact', {
      title: 'Research A',
      subject: 'db',
      predicate: 'has',
      object: 'finding-a',
      tags: ['research-db'],
    }, '# Fact A\n', 'agent-fact', { pathOverride: 'facts/research-a.md' });
    store.update(
      workspacePath,
      factA.path,
      { created: new Date(cursorMs + 1_000).toISOString() },
      undefined,
      'agent-fact',
    );

    const underThresholdCycle = triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'system',
      now: new Date(cursorMs + 1_500),
    });
    expect(underThresholdCycle.fired).toBe(0);

    const factB = store.create(workspacePath, 'fact', {
      title: 'Research B',
      subject: 'db',
      predicate: 'has',
      object: 'finding-b',
      tags: ['research-storage'],
    }, '# Fact B\n', 'agent-fact', { pathOverride: 'facts/research-b.md' });
    store.update(
      workspacePath,
      factB.path,
      { created: new Date(cursorMs + 2_000).toISOString() },
      undefined,
      'agent-fact',
    );

    const thresholdCycle = triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'system',
      now: new Date(cursorMs + 2_500),
    });
    expect(thresholdCycle.fired).toBe(1);
    expect(store.list(workspacePath, 'thread').some((entry) => String(entry.fields.title).includes('Synthesis needed'))).toBe(true);

    const steadyCycle = triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'system',
      now: new Date(cursorMs + 3_500),
    });
    expect(steadyCycle.fired).toBe(0);
    const state = triggerEngine.loadTriggerState(workspacePath);
    expect(state.triggers[synthesis.trigger.path]?.fireCount).toBe(1);
  });

  it('builds trigger dashboard with fire counts and next fire', () => {
    const cronTrigger = store.create(workspacePath, 'trigger', {
      title: 'Minutely dispatch',
      status: 'active',
      condition: { type: 'cron', expression: '* * * * *' },
      action: { type: 'dispatch-run', objective: 'Cron dispatch objective' },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    const cycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(cycle.fired).toBe(1);

    const dashboard = triggerEngine.triggerDashboard(workspacePath);
    const item = dashboard.triggers.find((trigger) => trigger.path === cronTrigger.path);
    expect(item).toBeDefined();
    expect(item?.fireCount).toBe(1);
    expect(item?.lastFiredAt).toBeDefined();
    expect(item?.nextFireAt).toBeDefined();
    expect(item?.currentState).toBe('ready');
  });

  it('fires webhook actions with templated payloads and records transport delivery', async () => {
    const server = await startWebhookTestServer('success');
    try {
      const webhookTrigger = store.create(workspacePath, 'trigger', {
        title: 'Webhook on completed threads',
        status: 'active',
        condition: { type: 'event', pattern: 'thread.*' },
        action: {
          type: 'webhook',
          url: server.url,
          headers: {
            'x-workgraph-target': '{{matched_event_latest_target}}',
          },
          bodyTemplate: {
            target: '{{matched_event_latest_target}}',
            op: '{{matched_event_latest_op}}',
            count: '{{matched_event_count}}',
          },
        },
        cooldown: 0,
      }, '# Trigger\n', 'system');

      const initCycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
      expect(initCycle.fired).toBe(0);

      const sourceThread = thread.createThread(workspacePath, 'Webhook source', 'Drive webhook trigger', 'agent-webhook');
      thread.claim(workspacePath, sourceThread.path, 'agent-webhook');
      thread.done(workspacePath, sourceThread.path, 'agent-webhook', 'Webhook done https://github.com/versatly/workgraph/pull/88');

      const fireCycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
      expect(fireCycle.fired).toBe(1);

      const runtime = triggerEngine.loadTriggerState(workspacePath).triggers[webhookTrigger.path];
      const webhookResponse = JSON.parse(String(runtime?.lastResult?.response_body ?? '{}')) as {
        method?: string;
        headers?: Record<string, unknown>;
        body?: string;
      };
      expect(webhookResponse.method).toBe('POST');
      expect(webhookResponse.headers?.['x-workgraph-target']).toBe(sourceThread.path);
      const payload = JSON.parse(String(webhookResponse.body ?? '{}')) as Record<string, unknown>;
      expect(payload.target).toBe(sourceThread.path);
      expect(['update', 'done']).toContain(String(payload.op));
      expect(Number(payload.count)).toBeGreaterThanOrEqual(1);

      const outbox = transport.listTransportOutbox(workspacePath);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.status).toBe('delivered');
      expect(outbox[0]?.deliveryTarget).toBe(server.url);

      const webhookEntries = ledger.readAll(workspacePath).filter((entry) =>
        entry.target === webhookTrigger.path && entry.data?.action === 'webhook'
      );
      const successEntry = webhookEntries.find((entry) => entry.data?.fired === true);
      expect(successEntry).toBeDefined();
      expect(successEntry?.data?.status_code).toBe(202);
    } finally {
      await server.stop();
    }
  });

  it('marks webhook trigger failures as errors without crashing cycle', async () => {
    const server = await startWebhookTestServer('failure');
    try {
      const webhookTrigger = store.create(workspacePath, 'trigger', {
        title: 'Webhook failing target',
        status: 'active',
        condition: { type: 'cron', expression: '* * * * *' },
        action: {
          type: 'webhook',
          url: server.url,
          bodyTemplate: {
            ping: 'pong',
          },
        },
        cooldown: 0,
      }, '# Trigger\n', 'system');

      const cycle = triggerEngine.runTriggerEngineCycle(workspacePath, {
        actor: 'system',
        now: new Date('2026-03-01T00:00:00.000Z'),
      });
      expect(cycle.fired).toBe(0);
      expect(cycle.errors).toBe(1);

      const triggerResult = cycle.triggers.find((entry) => entry.triggerPath === webhookTrigger.path);
      expect(triggerResult?.runtimeState).toBe('error');
      expect(triggerResult?.error).toContain('Webhook request failed');

      const outbox = transport.listTransportOutbox(workspacePath);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.status).toBe('failed');

      const webhookEntries = ledger.readAll(workspacePath).filter((entry) =>
        entry.target === webhookTrigger.path && entry.data?.action === 'webhook'
      );
      const failureEntry = webhookEntries.find((entry) => entry.data?.fired === false);
      expect(failureEntry).toBeDefined();
      expect(String(failureEntry?.data?.error ?? '')).toContain('Webhook request failed');
    } finally {
      await server.stop();
    }
  });
});
