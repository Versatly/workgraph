import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DispatchRunAuditEvent, DispatchRunAuditEventKind } from './types.js';

const RUN_AUDIT_FILE = '.workgraph/dispatch-run-audit.jsonl';

export interface AppendDispatchRunAuditEventInput {
  runId: string;
  actor: string;
  kind: DispatchRunAuditEventKind;
  data?: Record<string, unknown>;
  ts?: string;
}

export function appendDispatchRunAuditEvent(
  workspacePath: string,
  input: AppendDispatchRunAuditEventInput,
): DispatchRunAuditEvent {
  const now = input.ts ?? new Date().toISOString();
  const existing = listDispatchRunAuditEvents(workspacePath, input.runId);
  const last = existing[existing.length - 1];
  const event: Omit<DispatchRunAuditEvent, 'hash'> = {
    id: `runevt_${randomUUID()}`,
    runId: input.runId,
    seq: (last?.seq ?? 0) + 1,
    ts: now,
    actor: input.actor,
    kind: input.kind,
    data: input.data ?? {},
    prevHash: last?.hash,
  };
  const hash = hashAuditEvent(event);
  const fullEvent: DispatchRunAuditEvent = {
    ...event,
    hash,
  };
  appendAuditLine(workspacePath, fullEvent);
  return fullEvent;
}

export function listDispatchRunAuditEvents(
  workspacePath: string,
  runId?: string,
): DispatchRunAuditEvent[] {
  const filePath = runAuditPath(workspacePath);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const parsed: DispatchRunAuditEvent[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as DispatchRunAuditEvent;
      if (runId && event.runId !== runId) continue;
      parsed.push(event);
    } catch {
      continue;
    }
  }
  return parsed;
}

export function runAuditPath(workspacePath: string): string {
  return path.join(workspacePath, RUN_AUDIT_FILE);
}

function appendAuditLine(workspacePath: string, event: DispatchRunAuditEvent): void {
  const filePath = runAuditPath(workspacePath);
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf-8');
}

function hashAuditEvent(event: Omit<DispatchRunAuditEvent, 'hash'>): string {
  return createHash('sha256')
    .update(JSON.stringify(event))
    .digest('hex');
}
