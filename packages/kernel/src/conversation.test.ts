import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createThread } from './thread.js';
import { loadRegistry, saveRegistry } from './registry.js';
import {
  appendConversationMessage,
  attachConversationThread,
  createConversation,
  createPlanStep,
  detachConversationThread,
  getConversation,
  listConversations,
  listPlanSteps,
  summarizeConversationState,
  updatePlanStepProgress,
  updatePlanStepStatus,
} from './conversation.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-conversation-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('conversation primitives', () => {
  it('creates conversations and supports message + thread coordination flows', () => {
    const threadA = createThread(workspacePath, 'Auth integration', 'Wire auth provider', 'agent-a');
    const threadB = createThread(workspacePath, 'Billing integration', 'Wire billing provider', 'agent-a');
    const created = createConversation(workspacePath, 'Cross-team coordination', 'agent-a', {
      threadRefs: [threadA.path, threadB.path],
      tags: ['coordination'],
    });

    expect(created.conversation.path).toBe('conversations/cross-team-coordination.md');
    expect(created.summary.threadRefs).toEqual([threadA.path, threadB.path].sort((left, right) => left.localeCompare(right)));
    expect(created.summary.status).toBe('open');
    expect(created.summary.messageCount).toBe(0);

    const messaged = appendConversationMessage(
      workspacePath,
      created.conversation.path,
      'agent-b',
      'API contract finalized and ready for implementation.',
      {
        kind: 'decision',
        threadRef: threadA.path,
      },
    );
    expect(messaged.summary.messageCount).toBe(1);
    expect(messaged.summary.status).toBe('active');

    const detached = detachConversationThread(workspacePath, created.conversation.path, threadB.path, 'agent-a');
    expect(detached.summary.threadRefs).toEqual([threadA.path]);
    const reattached = attachConversationThread(workspacePath, created.conversation.path, threadB.path, 'agent-a');
    expect(reattached.summary.threadRefs).toEqual([threadA.path, threadB.path].sort((left, right) => left.localeCompare(right)));

    const listed = listConversations(workspacePath, { threadRef: threadA.path });
    expect(listed).toHaveLength(1);
    expect(listed[0].conversation.path).toBe(created.conversation.path);

    const loaded = getConversation(workspacePath, created.conversation.path);
    expect(loaded.summary.messageCount).toBe(1);
  });

  it('tracks plan-step progress and updates conversation state summaries', () => {
    const thread = createThread(workspacePath, 'Rollout task', 'Coordinate release rollout', 'agent-lead');
    const conversation = createConversation(workspacePath, 'Release train', 'agent-lead', {
      threadRefs: [thread.path],
    });

    const stepOne = createPlanStep(workspacePath, 'Draft changelog', 'agent-lead', {
      conversationRef: conversation.conversation.path,
      threadRef: thread.path,
      order: 1,
    });
    const stepTwo = createPlanStep(workspacePath, 'Run rollout checklist', 'agent-lead', {
      conversationRef: conversation.conversation.path,
      threadRef: thread.path,
      order: 2,
    });

    let summary = summarizeConversationState(workspacePath, conversation.conversation.path);
    expect(summary.steps.total).toBe(2);
    expect(summary.progress).toBe(0);
    expect(summary.status).toBe('open');

    const inProgress = updatePlanStepProgress(workspacePath, stepOne.path, 40, 'agent-lead');
    expect(inProgress.fields.status).toBe('active');
    summary = summarizeConversationState(workspacePath, conversation.conversation.path);
    expect(summary.steps.active).toBe(1);
    expect(summary.progress).toBe(20);

    updatePlanStepStatus(workspacePath, stepTwo.path, 'blocked', 'agent-lead', { reason: 'Waiting on QA testbed' });
    summary = summarizeConversationState(workspacePath, conversation.conversation.path);
    expect(summary.steps.blocked).toBe(1);
    expect(summary.status).toBe('blocked');

    updatePlanStepStatus(workspacePath, stepTwo.path, 'active', 'agent-lead');
    updatePlanStepStatus(workspacePath, stepOne.path, 'done', 'agent-lead');
    updatePlanStepStatus(workspacePath, stepTwo.path, 'done', 'agent-lead');
    summary = summarizeConversationState(workspacePath, conversation.conversation.path);
    expect(summary.steps.done).toBe(2);
    expect(summary.progress).toBe(100);
    expect(summary.status).toBe('done');
  });

  it('validates plan-step transitions and rejects invalid updates', () => {
    const thread = createThread(workspacePath, 'Validation thread', 'Validation checks', 'agent-a');
    const conversation = createConversation(workspacePath, 'Validation conversation', 'agent-a', {
      threadRefs: [thread.path],
    });
    const step = createPlanStep(workspacePath, 'Run validation', 'agent-a', {
      conversationRef: conversation.conversation.path,
      threadRef: thread.path,
    });

    expect(() =>
      updatePlanStepStatus(workspacePath, step.path, 'blocked', 'agent-a')
    ).toThrow('requires a reason');

    updatePlanStepStatus(workspacePath, step.path, 'done', 'agent-a');
    expect(() =>
      updatePlanStepStatus(workspacePath, step.path, 'active', 'agent-a')
    ).toThrow('Invalid plan-step transition');
    expect(() =>
      updatePlanStepProgress(workspacePath, step.path, 25, 'agent-a')
    ).toThrow('terminal status');

    expect(() =>
      attachConversationThread(workspacePath, conversation.conversation.path, 'threads/missing-thread.md', 'agent-a')
    ).toThrow('Thread reference not found');
  });

  it('supports multi-thread plan-step filtering', () => {
    const api = createThread(workspacePath, 'API lane', 'Ship API scope', 'agent-a');
    const ui = createThread(workspacePath, 'UI lane', 'Ship UI scope', 'agent-a');
    const conversation = createConversation(workspacePath, 'API + UI sync', 'agent-a', {
      threadRefs: [api.path, ui.path],
    });
    createPlanStep(workspacePath, 'API schema pass', 'agent-a', {
      conversationRef: conversation.conversation.path,
      threadRef: api.path,
      order: 2,
    });
    createPlanStep(workspacePath, 'UI polish pass', 'agent-a', {
      conversationRef: conversation.conversation.path,
      threadRef: ui.path,
      order: 1,
    });

    const byConversation = listPlanSteps(workspacePath, { conversationRef: conversation.conversation.path });
    expect(byConversation).toHaveLength(2);
    expect(byConversation.map((step) => String(step.fields.title))).toEqual([
      'UI polish pass',
      'API schema pass',
    ]);
    const apiSteps = listPlanSteps(workspacePath, { threadRef: api.path });
    expect(apiSteps).toHaveLength(1);
    expect(String(apiSteps[0].fields.thread_ref)).toBe(api.path);
  });
});
