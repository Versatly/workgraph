import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addEvidence,
  approve,
  claim,
  createThread,
  inviteParticipant,
  joinParticipant,
  leaveParticipant,
  listParticipants,
  reject,
} from './thread.js';
import { loadRegistry, saveRegistry } from './registry.js';
import * as ledger from './ledger.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-thread-participants-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('thread participants', () => {
  it('supports participant invite/join/leave CRUD operations', () => {
    const thread = createThread(workspacePath, 'Multi participant task', 'coordinate work', 'owner-a');
    expect(thread.fields.participants).toBeDefined();

    inviteParticipant(workspacePath, thread.path, 'owner-a', 'reviewer-a', 'reviewer');
    inviteParticipant(workspacePath, thread.path, 'owner-a', 'observer-a', 'observer');
    joinParticipant(workspacePath, thread.path, 'contributor-a');

    const joined = listParticipants(workspacePath, thread.path);
    expect(joined).toHaveLength(4);
    expect(joined.find((entry) => entry.agentId === 'owner-a')?.role).toBe('owner');
    expect(joined.find((entry) => entry.agentId === 'reviewer-a')?.role).toBe('reviewer');
    expect(joined.find((entry) => entry.agentId === 'observer-a')?.role).toBe('observer');
    expect(joined.find((entry) => entry.agentId === 'contributor-a')?.role).toBe('contributor');

    leaveParticipant(workspacePath, thread.path, 'contributor-a');
    const afterLeave = listParticipants(workspacePath, thread.path);
    expect(afterLeave.some((entry) => entry.agentId === 'contributor-a')).toBe(false);
  });

  it('enforces role-based permissions for evidence and review actions', () => {
    const thread = createThread(workspacePath, 'Review workflow', 'collect evidence and review', 'owner-a');
    inviteParticipant(workspacePath, thread.path, 'owner-a', 'reviewer-a', 'reviewer');
    inviteParticipant(workspacePath, thread.path, 'owner-a', 'observer-a', 'observer');
    joinParticipant(workspacePath, thread.path, 'contributor-a');

    const withEvidence = addEvidence(
      workspacePath,
      thread.path,
      'contributor-a',
      'https://github.com/versatly/workgraph/pull/13',
    );
    const evidenceLog = Array.isArray(withEvidence.fields.evidence_log) ? withEvidence.fields.evidence_log : [];
    expect(evidenceLog.length).toBe(1);

    expect(() => addEvidence(workspacePath, thread.path, 'observer-a', 'https://example.org'))
      .toThrow('requires role(s): owner, contributor');

    const approved = approve(workspacePath, thread.path, 'reviewer-a', 'LGTM');
    expect(approved.fields.review_status).toBe('approved');
    expect(approved.fields.reviewed_by).toBe('reviewer-a');

    const rejected = reject(workspacePath, thread.path, 'reviewer-a', 'Needs stronger test evidence');
    expect(rejected.fields.review_status).toBe('rejected');
    expect(rejected.fields.review_reason).toBe('Needs stronger test evidence');

    expect(() => approve(workspacePath, thread.path, 'contributor-a'))
      .toThrow('requires role(s): owner, reviewer');

    expect(() => claim(workspacePath, thread.path, 'observer-a'))
      .toThrow('observer');
  });

  it('records participant identity in thread ledger entries', () => {
    const thread = createThread(workspacePath, 'Ledger attribution', 'verify participant identity metadata', 'owner-a');
    joinParticipant(workspacePath, thread.path, 'contributor-a');
    addEvidence(workspacePath, thread.path, 'contributor-a', 'https://github.com/versatly/workgraph/pull/99');

    const history = ledger.historyOf(workspacePath, thread.path);
    const evidenceEntry = history.find((entry) =>
      entry.op === 'update' && entry.data?.participant_event === 'evidence'
    );

    expect(evidenceEntry).toBeDefined();
    expect(evidenceEntry?.data?.participant_agent_id).toBe('contributor-a');
    expect(evidenceEntry?.data?.participant_role).toBe('contributor');
  });
});
