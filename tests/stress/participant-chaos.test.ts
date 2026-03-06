import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  registry as registryModule,
  thread as threadModule,
} from '@versatly/workgraph-kernel';

const registry = registryModule;
const thread = threadModule;

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-stress-participant-chaos-'));
  registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('stress: participant chaos and permission invariants', () => {
  it('keeps participants consistent under concurrent join/leave and role checks', { timeout: 30_000 }, async () => {
    const chaosThread = thread.createThread(
      workspacePath,
      'Participant chaos',
      'Stress participant joins/leaves.',
      'agent-owner',
    );
    thread.inviteThreadParticipant(
      workspacePath,
      chaosThread.path,
      'agent-owner',
      'agent-backup-owner',
      'owner',
    );

    const actors = Array.from({ length: 20 }, (_value, idx) => `agent-${idx}`);
    const roleForActor = (name: string): 'observer' | 'reviewer' | 'contributor' => {
      const idx = Number.parseInt(name.replace('agent-', ''), 10);
      if (idx % 3 === 0) return 'observer';
      if (idx % 3 === 1) return 'reviewer';
      return 'contributor';
    };

    await Promise.all(
      actors.map(async (actor) => {
        for (let pass = 0; pass < 20; pass += 1) {
          if (pass % 2 === 0) {
            thread.joinThread(workspacePath, chaosThread.path, actor, roleForActor(actor));
          } else {
            thread.leaveThread(workspacePath, chaosThread.path, actor);
          }
          await Promise.resolve();
        }
      }),
    );

    const participants = thread.listThreadParticipants(workspacePath, chaosThread.path);
    const participantActors = participants.map((entry) => entry.actor);
    expect(new Set(participantActors).size).toBe(participantActors.length);
    expect(participants.some((entry) => entry.role === 'owner')).toBe(true);

    const permissionsThread = thread.createThread(
      workspacePath,
      'Permission chaos',
      'Role checks under concurrent access.',
      'agent-owner',
    );
    thread.inviteThreadParticipant(workspacePath, permissionsThread.path, 'agent-owner', 'agent-observer', 'observer');
    thread.inviteThreadParticipant(workspacePath, permissionsThread.path, 'agent-owner', 'agent-reviewer', 'reviewer');
    thread.inviteThreadParticipant(workspacePath, permissionsThread.path, 'agent-owner', 'agent-contributor', 'contributor');

    const attempts = 25;
    const [observerFailures, reviewerFailures, contributorFailures] = await Promise.all([
      runPermissionAttempts(attempts, () => {
        thread.claim(workspacePath, permissionsThread.path, 'agent-observer');
      }, 'thread claims'),
      runPermissionAttempts(attempts, () => {
        thread.block(workspacePath, permissionsThread.path, 'agent-reviewer', 'threads/dep.md');
      }, 'thread lifecycle mutations'),
      runPermissionAttempts(attempts, () => {
        thread.inviteThreadParticipant(
          workspacePath,
          permissionsThread.path,
          'agent-contributor',
          `agent-extra-${Math.random()}`,
          'observer',
        );
      }, 'participant management'),
    ]);

    expect(observerFailures).toBe(attempts);
    expect(reviewerFailures).toBe(attempts);
    expect(contributorFailures).toBe(attempts);

    const finalParticipants = thread.listThreadParticipants(workspacePath, permissionsThread.path);
    expect(finalParticipants.some((entry) => entry.actor === 'agent-owner' && entry.role === 'owner')).toBe(true);
    expect(finalParticipants.some((entry) => entry.actor === 'agent-observer' && entry.role === 'observer')).toBe(true);
    expect(finalParticipants.some((entry) => entry.actor === 'agent-reviewer' && entry.role === 'reviewer')).toBe(true);
  });
});

async function runPermissionAttempts(
  attempts: number,
  action: () => void,
  expectedMessagePart: string,
): Promise<number> {
  let failures = 0;
  for (let idx = 0; idx < attempts; idx += 1) {
    try {
      action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(expectedMessagePart);
      failures += 1;
    }
    await Promise.resolve();
  }
  return failures;
}
