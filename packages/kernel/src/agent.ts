/**
 * Agent presence primitives.
 */

import * as store from './store.js';
import type { PrimitiveInstance } from './types.js';

export type AgentPresenceStatus = 'online' | 'busy' | 'offline';

export interface AgentHeartbeatOptions {
  status?: AgentPresenceStatus;
  currentTask?: string;
  capabilities?: string[];
  actor?: string;
}

const PRESENCE_TYPE = 'presence';
const PRESENCE_STATUS_VALUES = new Set<AgentPresenceStatus>(['online', 'busy', 'offline']);

export function heartbeat(
  workspacePath: string,
  name: string,
  options: AgentHeartbeatOptions = {},
): PrimitiveInstance {
  const existing = getPresence(workspacePath, name);
  const now = new Date().toISOString();
  const status = normalizeStatus(options.status ?? existing?.fields.status) ?? 'online';
  const capabilities = normalizeCapabilities(options.capabilities ?? existing?.fields.capabilities);
  const actor = options.actor ?? name;
  const currentTask = options.currentTask !== undefined
    ? normalizeTask(options.currentTask)
    : normalizeTask(existing?.fields.current_task);

  if (!existing) {
    return store.create(
      workspacePath,
      PRESENCE_TYPE,
      {
        name,
        status,
        current_task: currentTask,
        last_seen: now,
        capabilities,
      },
      renderPresenceBody(name, status, currentTask, capabilities, now),
      actor,
    );
  }

  return store.update(
    workspacePath,
    existing.path,
    {
      name,
      status,
      current_task: currentTask,
      last_seen: now,
      capabilities,
    },
    renderPresenceBody(name, status, currentTask, capabilities, now),
    actor,
  );
}

export function list(workspacePath: string): PrimitiveInstance[] {
  return store.list(workspacePath, PRESENCE_TYPE)
    .sort((a, b) => {
      const aSeen = Date.parse(String(a.fields.last_seen ?? ''));
      const bSeen = Date.parse(String(b.fields.last_seen ?? ''));
      const safeA = Number.isFinite(aSeen) ? aSeen : 0;
      const safeB = Number.isFinite(bSeen) ? bSeen : 0;
      if (safeA !== safeB) return safeB - safeA;
      return String(a.fields.name ?? '').localeCompare(String(b.fields.name ?? ''));
    });
}

export function getPresence(workspacePath: string, name: string): PrimitiveInstance | null {
  const target = normalizeName(name);
  return list(workspacePath)
    .find((entry) => normalizeName(entry.fields.name) === target) ?? null;
}

function normalizeStatus(value: unknown): AgentPresenceStatus | null {
  const normalized = String(value ?? '').trim().toLowerCase() as AgentPresenceStatus;
  if (!PRESENCE_STATUS_VALUES.has(normalized)) return null;
  return normalized;
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

function normalizeTask(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
}

function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function renderPresenceBody(
  name: string,
  status: AgentPresenceStatus,
  currentTask: string | null,
  capabilities: string[],
  lastSeen: string,
): string {
  const lines = [
    '## Presence',
    '',
    `- agent: ${name}`,
    `- status: ${status}`,
    `- last_seen: ${lastSeen}`,
    `- current_task: ${currentTask ?? 'none'}`,
    '',
    '## Capabilities',
    '',
    ...(capabilities.length > 0
      ? capabilities.map((capability) => `- ${capability}`)
      : ['- none']),
    '',
  ];
  return lines.join('\n');
}
