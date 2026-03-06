import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  block,
  claim,
  createThread,
  done,
  inviteThreadParticipant,
  joinThread,
  leaveThread,
  listThreadParticipants,
} from './thread.js';
import { loadRegistry, saveRegistry } from './registry.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-thread-participants-'));
  saveRegistry(workspacePath, loadRegistry(workspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('thread participants', () => {
  it('seeds thread creator as owner participant', () => {
    const thread = createThread(workspacePath, 'Participant Seed', 'seed owners', 'agent-owner');
    const participants = listThreadParticipants(workspacePath, thread.path);

    expect(participants).toHaveLength(1);
    expect(participants[0].actor).toBe('agent-owner');
    expect(participants[0].role).toBe('owner');
  });

  it('supports inviting participants and self-join', () => {
    const thread = createThread(workspacePath, 'Invite Flow', 'test participant changes', 'agent-owner');
    inviteThreadParticipant(workspacePath, thread.path, 'agent-owner', 'agent-reviewer', 'reviewer');
    joinThread(workspacePath, thread.path, 'agent-observer', 'observer');
    const participants = listThreadParticipants(workspacePath, thread.path);

    expect(participants.map((entry) => `${entry.actor}:${entry.role}`)).toEqual([
      'agent-observer:observer',
      'agent-owner:owner',
      'agent-reviewer:reviewer',
    ]);
  });

  it('blocks observer claim attempts', () => {
    const thread = createThread(workspacePath, 'Observer cannot claim', 'permissions', 'agent-owner');
    inviteThreadParticipant(workspacePath, thread.path, 'agent-owner', 'agent-observer', 'observer');

    expect(() => claim(workspacePath, thread.path, 'agent-observer')).toThrow('cannot perform "thread claims"');
  });

  it('allows reviewer to claim and complete a thread', () => {
    const thread = createThread(workspacePath, 'Reviewer completion', 'permissions', 'agent-owner');
    inviteThreadParticipant(workspacePath, thread.path, 'agent-owner', 'agent-reviewer', 'reviewer');

    const claimed = claim(workspacePath, thread.path, 'agent-reviewer');
    expect(claimed.fields.owner).toBe('agent-reviewer');

    const completed = done(
      workspacePath,
      thread.path,
      'agent-reviewer',
      'reviewed and approved https://github.com/versatly/workgraph/pull/99',
    );
    expect(completed.fields.status).toBe('done');
  });

  it('prevents contributors from managing participants', () => {
    const thread = createThread(workspacePath, 'Contributor limits', 'permissions', 'agent-owner');
    inviteThreadParticipant(workspacePath, thread.path, 'agent-owner', 'agent-contrib', 'contributor');

    expect(() =>
      inviteThreadParticipant(workspacePath, thread.path, 'agent-contrib', 'agent-extra', 'observer'),
    ).toThrow('participant management');
  });

  it('rejects leaving when it would remove last owner', () => {
    const thread = createThread(workspacePath, 'Owner retention', 'permissions', 'agent-owner');

    expect(() => leaveThread(workspacePath, thread.path, 'agent-owner')).toThrow('at least one owner');
  });

  it('rejects removing an actively owning participant', () => {
    const thread = createThread(workspacePath, 'Active owner retention', 'permissions', 'agent-owner');
    claim(workspacePath, thread.path, 'agent-owner');
    inviteThreadParticipant(workspacePath, thread.path, 'agent-owner', 'agent-secondary', 'owner');

    expect(() =>
      leaveThread(workspacePath, thread.path, 'agent-secondary', 'agent-owner'),
    ).toThrow('Release or handoff first');
  });

  it('enforces role permissions on lifecycle mutations', () => {
    const thread = createThread(workspacePath, 'Role mutation control', 'permissions', 'agent-owner');
    inviteThreadParticipant(workspacePath, thread.path, 'agent-owner', 'agent-reviewer', 'reviewer');
    claim(workspacePath, thread.path, 'agent-reviewer');

    expect(() => block(workspacePath, thread.path, 'agent-reviewer', 'threads/dep.md')).toThrow(
      'thread lifecycle mutations',
    );
  });
});
