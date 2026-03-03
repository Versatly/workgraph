import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ledger from './ledger.js';
import * as registry from './registry.js';
import * as store from './store.js';
import * as thread from './thread.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-thread-hardening-'));
  registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('thread hardening', () => {
  it('requires evidence by default when marking done', () => {
    thread.createThread(workspacePath, 'Evidence required', 'ship work', 'agent-a');
    thread.claim(workspacePath, 'threads/evidence-required.md', 'agent-a');

    expect(() =>
      thread.done(workspacePath, 'threads/evidence-required.md', 'agent-a', 'finished without proof'),
    ).toThrow('at least one valid evidence item is required');
  });

  it('rejects fake evidence urls on done transition', () => {
    thread.createThread(workspacePath, 'Reject fake url', 'ship work', 'agent-a');
    thread.claim(workspacePath, 'threads/reject-fake-url.md', 'agent-a');

    expect(() =>
      thread.done(workspacePath, 'threads/reject-fake-url.md', 'agent-a', 'proof https://example.com/fake'),
    ).toThrow('at least one valid evidence item is required');
  });

  it('persists validated evidence on done ledger entries', () => {
    thread.createThread(workspacePath, 'Persist evidence', 'ship work', 'agent-a');
    thread.claim(workspacePath, 'threads/persist-evidence.md', 'agent-a');
    thread.done(
      workspacePath,
      'threads/persist-evidence.md',
      'agent-a',
      'proof https://github.com/versatly/workgraph/pull/31',
    );

    const doneEntry = ledger.historyOf(workspacePath, 'threads/persist-evidence.md').find((entry) => entry.op === 'done');
    expect(doneEntry).toBeDefined();
    expect(doneEntry?.data?.evidence_policy).toBe('strict');
    expect(Array.isArray(doneEntry?.data?.evidence)).toBe(true);
    expect((doneEntry?.data?.evidence as Array<{ type: string; value: string }>)[0].type).toBe('url');
  });

  it('accepts explicit evidence options on done', () => {
    thread.createThread(workspacePath, 'Explicit evidence', 'ship work', 'agent-a');
    thread.claim(workspacePath, 'threads/explicit-evidence.md', 'agent-a');
    const completed = thread.done(
      workspacePath,
      'threads/explicit-evidence.md',
      'agent-a',
      undefined,
      {
        evidence: [{ type: 'thread-ref', value: 'threads/explicit-evidence.md' }],
      },
    );
    expect(completed.fields.status).toBe('done');
  });

  it('blocks parent done when any descendant is unresolved', () => {
    const parent = thread.createThread(workspacePath, 'Parent thread', 'complete parent', 'agent-a');
    thread.decompose(workspacePath, parent.path, [{ title: 'Child open', goal: 'still open' }], 'agent-a');
    thread.claim(workspacePath, parent.path, 'agent-a');

    expect(() =>
      thread.done(
        workspacePath,
        parent.path,
        'agent-a',
        'proof https://github.com/versatly/workgraph/pull/32',
      ),
    ).toThrow('Unresolved descendants');
  });

  it('allows parent done once descendants are done or cancelled', () => {
    const parent = thread.createThread(workspacePath, 'Parent complete', 'complete parent', 'agent-a');
    const [child] = thread.decompose(workspacePath, parent.path, [{ title: 'Child done', goal: 'close child' }], 'agent-a');
    thread.claim(workspacePath, child.path, 'agent-a');
    thread.done(
      workspacePath,
      child.path,
      'agent-a',
      'proof https://github.com/versatly/workgraph/pull/33',
    );
    thread.claim(workspacePath, parent.path, 'agent-a');
    const completedParent = thread.done(
      workspacePath,
      parent.path,
      'agent-a',
      'proof https://github.com/versatly/workgraph/pull/34',
    );
    expect(completedParent.fields.status).toBe('done');
  });

  it('treats cancelled descendants as resolved for parent done checks', () => {
    const parent = thread.createThread(workspacePath, 'Parent cancel child', 'complete parent', 'agent-a');
    const [child] = thread.decompose(workspacePath, parent.path, [{ title: 'Child cancelled', goal: 'cancel child' }], 'agent-a');
    thread.cancel(workspacePath, child.path, 'agent-a', 'obsolete');
    thread.claim(workspacePath, parent.path, 'agent-a');

    const completed = thread.done(
      workspacePath,
      parent.path,
      'agent-a',
      'proof https://github.com/versatly/workgraph/pull/35',
    );
    expect(completed.fields.status).toBe('done');
  });

  it('logs rejected ledger entries for blocked terminal lock operations', () => {
    thread.createThread(workspacePath, 'Lock rejection', 'lock me', 'agent-a');
    thread.claim(workspacePath, 'threads/lock-rejection.md', 'agent-a');
    thread.done(
      workspacePath,
      'threads/lock-rejection.md',
      'agent-a',
      'proof https://github.com/versatly/workgraph/pull/36',
    );

    expect(() =>
      thread.block(workspacePath, 'threads/lock-rejection.md', 'agent-a', 'external/dep'),
    ).toThrow('terminally locked');

    const rejected = ledger.historyOf(workspacePath, 'threads/lock-rejection.md')
      .filter((entry) => entry.op === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].data?.attempted_op).toBe('block');
  });

  it('rejects late claim attempts against done threads with terminal lock', () => {
    thread.createThread(workspacePath, 'Late claim', 'lock me', 'agent-a');
    thread.claim(workspacePath, 'threads/late-claim.md', 'agent-a');
    thread.done(
      workspacePath,
      'threads/late-claim.md',
      'agent-a',
      'proof https://github.com/versatly/workgraph/pull/37',
    );

    expect(() => thread.claim(workspacePath, 'threads/late-claim.md', 'agent-b')).toThrow('terminally locked');
    const rejected = ledger.historyOf(workspacePath, 'threads/late-claim.md').filter((entry) => entry.op === 'rejected');
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected[rejected.length - 1].data?.attempted_op).toBe('claim');
  });

  it('does not log terminal-lock rejections when terminalLock is disabled', () => {
    thread.createThread(workspacePath, 'Lock disabled', 'lock me', 'agent-a');
    thread.claim(workspacePath, 'threads/lock-disabled.md', 'agent-a');
    store.update(workspacePath, 'threads/lock-disabled.md', { terminalLock: false }, undefined, 'agent-a');
    thread.done(
      workspacePath,
      'threads/lock-disabled.md',
      'agent-a',
      'proof https://github.com/versatly/workgraph/pull/38',
    );

    expect(() => thread.claim(workspacePath, 'threads/lock-disabled.md', 'agent-b')).toThrow('Cannot claim thread in "done" state');
    const rejected = ledger.historyOf(workspacePath, 'threads/lock-disabled.md').filter((entry) => entry.op === 'rejected');
    expect(rejected).toHaveLength(0);
  });

  it('requires reason for reopen when reopening a done thread', () => {
    thread.createThread(workspacePath, 'Reasoned reopen', 'lock me', 'agent-a');
    thread.claim(workspacePath, 'threads/reasoned-reopen.md', 'agent-a');
    thread.done(
      workspacePath,
      'threads/reasoned-reopen.md',
      'agent-a',
      'proof https://github.com/versatly/workgraph/pull/39',
    );

    expect(() => thread.reopen(workspacePath, 'threads/reasoned-reopen.md', 'agent-a')).toThrow('Reopen requires a reason');
  });

  it('supports evidencePolicy none gates that allow empty evidence', () => {
    const gate = store.create(workspacePath, 'policy-gate', {
      title: 'No evidence required',
      status: 'active',
      evidencePolicy: 'none',
    }, '# Gate', 'agent-policy');
    const threadInstance = thread.createThread(workspacePath, 'No evidence policy', 'complete without proof', 'agent-a');
    store.update(workspacePath, threadInstance.path, { gates: [gate.path] }, undefined, 'agent-a');
    thread.claim(workspacePath, threadInstance.path, 'agent-a');

    const completed = thread.done(workspacePath, threadInstance.path, 'agent-a');
    expect(completed.fields.status).toBe('done');
  });

  it('supports relaxed evidence policy with mixed valid and invalid evidence', () => {
    const gate = store.create(workspacePath, 'policy-gate', {
      title: 'Relaxed evidence',
      status: 'active',
      evidencePolicy: 'relaxed',
    }, '# Gate', 'agent-policy');
    const threadInstance = thread.createThread(workspacePath, 'Relaxed evidence task', 'complete with partial proof', 'agent-a');
    store.update(workspacePath, threadInstance.path, { gates: [gate.path] }, undefined, 'agent-a');
    thread.claim(workspacePath, threadInstance.path, 'agent-a');

    const completed = thread.done(
      workspacePath,
      threadInstance.path,
      'agent-a',
      'proof https://github.com/versatly/workgraph/pull/40 and https://example.com/fake',
    );
    expect(completed.fields.status).toBe('done');
  });

  it('enforces strict evidence policy when configured gate requires strict mode', () => {
    const gate = store.create(workspacePath, 'policy-gate', {
      title: 'Strict evidence',
      status: 'active',
      evidencePolicy: 'strict',
    }, '# Gate', 'agent-policy');
    const threadInstance = thread.createThread(workspacePath, 'Strict evidence task', 'complete with strict proof', 'agent-a');
    store.update(workspacePath, threadInstance.path, { gates: [gate.path] }, undefined, 'agent-a');
    thread.claim(workspacePath, threadInstance.path, 'agent-a');

    expect(() =>
      thread.done(
        workspacePath,
        threadInstance.path,
        'agent-a',
        'proof https://github.com/versatly/workgraph/pull/41 and https://example.com/fake',
      ),
    ).toThrow('invalid evidence detected');
  });
});
