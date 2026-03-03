import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ledger as ledgerModule,
  type LedgerEntry,
} from '@versatly/workgraph-kernel';
import {
  createDashboardEventFilter,
  listDashboardEventsSince,
  mapLedgerEntryToDashboardEvents,
  toSsePayload,
} from './server-events.js';

const ledger = ledgerModule;

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-server-events-'));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('server dashboard events', () => {
  it('maps deterministic per-event ids and deterministic SSE envelope shape', () => {
    const entry: LedgerEntry = {
      ts: '2026-03-01T00:00:00.000Z',
      actor: 'agent-a',
      op: 'create',
      target: 'threads/deterministic.md',
      type: 'thread',
      data: {
        status: 'open',
      },
      hash: 'hash-deterministic',
      prevHash: 'GENESIS',
    };

    const events = mapLedgerEntryToDashboardEvents(entry);
    expect(events.map((event) => event.id)).toEqual([
      'hash-deterministic#thread.created',
      'hash-deterministic#primitive.changed',
      'hash-deterministic#ledger.appended',
    ]);

    const payload = toSsePayload(events[0]);
    const dataLine = payload.split('\n').find((line) => line.startsWith('data: '));
    expect(dataLine).toBeDefined();
    const envelope = JSON.parse(dataLine!.slice('data: '.length)) as Record<string, unknown>;
    expect(Object.keys(envelope)).toEqual(['id', 'type', 'path', 'actor', 'fields', 'ts']);
    expect(envelope.id).toBe(events[0].id);
    expect(envelope.type).toBe('thread.created');
  });

  it('emits dedicated lifecycle events for conversation, plan-step, and run primitives', () => {
    const conversationEvents = mapLedgerEntryToDashboardEvents({
      ts: '2026-03-01T00:00:00.000Z',
      actor: 'agent-a',
      op: 'update',
      target: 'conversations/sync.md',
      type: 'conversation',
      hash: 'hash-conversation',
      prevHash: 'GENESIS',
      data: {
        changed: ['status'],
      },
    });
    expect(conversationEvents.map((event) => event.type)).toEqual([
      'conversation.updated',
      'primitive.changed',
      'ledger.appended',
    ]);

    const stepEvents = mapLedgerEntryToDashboardEvents({
      ts: '2026-03-01T00:00:01.000Z',
      actor: 'agent-b',
      op: 'create',
      target: 'plan-steps/ship-api.md',
      type: 'plan-step',
      hash: 'hash-plan-step',
      prevHash: 'hash-conversation',
      data: {
        status: 'open',
      },
    });
    expect(stepEvents.map((event) => event.type)).toEqual([
      'plan-step.updated',
      'primitive.changed',
      'ledger.appended',
    ]);

    const runEvents = mapLedgerEntryToDashboardEvents({
      ts: '2026-03-01T00:00:02.000Z',
      actor: 'agent-c',
      op: 'update',
      target: '.workgraph/runs/run_123',
      type: 'run',
      hash: 'hash-run',
      prevHash: 'hash-plan-step',
      data: {
        status: 'running',
      },
    });
    expect(runEvents.map((event) => event.type)).toEqual([
      'run.updated',
      'primitive.changed',
      'ledger.appended',
    ]);
  });

  it('replays from the exact event id, not only the ledger entry id', () => {
    ledger.append(workspacePath, 'seed', 'create', 'threads/replay.md', 'thread');
    ledger.append(workspacePath, 'seed', 'claim', 'threads/replay.md', 'thread');

    const allEvents = listDashboardEventsSince(workspacePath, undefined);
    expect(allEvents.length).toBeGreaterThan(4);
    const anchor = allEvents[1];

    const replay = listDashboardEventsSince(workspacePath, anchor.id);
    expect(replay.map((event) => event.id)).toEqual(
      allEvents.slice(2).map((event) => event.id),
    );

    const unknownReplay = listDashboardEventsSince(workspacePath, 'unknown-id');
    expect(unknownReplay.map((event) => event.id)).toEqual(
      allEvents.map((event) => event.id),
    );
  });

  it('filters by event type, primitive type, and thread path', () => {
    ledger.append(workspacePath, 'seed', 'create', 'threads/alpha.md', 'thread');
    ledger.append(workspacePath, 'seed', 'update', '.workgraph/runs/run_1', 'run', {
      status: 'running',
    });
    ledger.append(workspacePath, 'seed', 'update', 'conversations/alpha.md', 'conversation', {
      status: 'active',
    });

    const threadFilter = createDashboardEventFilter({
      threads: ['alpha'],
    });
    const threadEvents = listDashboardEventsSince(workspacePath, undefined, threadFilter);
    expect(threadEvents.length).toBeGreaterThan(0);
    expect(threadEvents.every((event) => event.path === 'threads/alpha.md')).toBe(true);

    const runFilter = createDashboardEventFilter({
      primitiveTypes: ['run'],
    });
    const runEvents = listDashboardEventsSince(workspacePath, undefined, runFilter);
    expect(runEvents.length).toBeGreaterThan(0);
    expect(runEvents.some((event) => event.type === 'run.updated')).toBe(true);
    expect(runEvents.every((event) => event.type === 'run.updated' || event.fields.type === 'run')).toBe(true);

    const conversationEventTypeFilter = createDashboardEventFilter({
      eventTypes: ['conversation.updated'],
    });
    const conversationLifecycleEvents = listDashboardEventsSince(
      workspacePath,
      undefined,
      conversationEventTypeFilter,
    );
    expect(conversationLifecycleEvents.length).toBe(1);
    expect(conversationLifecycleEvents[0].type).toBe('conversation.updated');
  });
});
