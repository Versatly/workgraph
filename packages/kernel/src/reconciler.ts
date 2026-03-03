import * as gate from './gate.js';
import * as ledger from './ledger.js';
import * as store from './store.js';
import { collectThreadEvidence, validateThreadEvidence } from './evidence.js';
import type {
  LedgerEntry,
  ReconcileIssue,
  ReconcileReport,
  ThreadEvidenceInput,
  ThreadEvidenceType,
  ThreadStatus,
} from './types.js';

const THREAD_STATUSES: ThreadStatus[] = ['open', 'active', 'blocked', 'done', 'cancelled'];

export function reconcile(workspacePath: string): ReconcileReport {
  const violations: ReconcileIssue[] = [];
  const warnings: ReconcileIssue[] = [];
  const entries = ledger.readAll(workspacePath);
  const threads = store.list(workspacePath, 'thread');
  const threadByPath = new Map(threads.map((thread) => [thread.path, thread]));

  for (const thread of threads) {
    const history = entries.filter((entry) => entry.target === thread.path);
    const currentStatus = normalizeStatus(thread.fields.status);
    const terminalLock = asBoolean(thread.fields.terminalLock, true);

    const tid = String(thread.fields.tid ?? '').trim();
    if (!tid) {
      violations.push(issue(
        'missing_tid',
        thread.path,
        'Thread is missing a T-ID (`tid`) field.',
      ));
    } else {
      if (!isKebabCase(tid)) {
        violations.push(issue(
          'invalid_tid',
          thread.path,
          `Thread T-ID "${tid}" must be kebab-case.`,
        ));
      }
      const slug = fileSlug(thread.path);
      if (slug && slug !== tid) {
        warnings.push(issue(
          'tid_path_mismatch',
          thread.path,
          `Thread T-ID "${tid}" does not match path slug "${slug}".`,
        ));
      }
    }

    if (history.length === 0) {
      violations.push(issue(
        'thread_without_ledger_history',
        thread.path,
        'Thread has no ledger history entries.',
      ));
    } else {
      const derivedStatus = deriveStatusFromLedger(history);
      if (derivedStatus && currentStatus && derivedStatus !== currentStatus) {
        violations.push(issue(
          'status_transition_missing_ledger',
          thread.path,
          `Thread status is "${currentStatus}" but ledger replay resolves to "${derivedStatus}".`,
          {
            currentStatus,
            derivedStatus,
          },
        ));
      }
    }

    if (currentStatus === 'done') {
      const latestDoneEntry = [...history].reverse().find((entry) => entry.op === 'done');
      if (!latestDoneEntry) {
        violations.push(issue(
          'done_without_ledger_entry',
          thread.path,
          'Thread is done but has no done ledger entry.',
        ));
      } else {
        const policy = gate.resolveThreadEvidencePolicy(workspacePath, thread);
        const doneEvidence = parseLedgerEvidence(latestDoneEntry.data?.evidence);
        const validation = validateThreadEvidence(doneEvidence, policy);
        if (!validation.ok) {
          violations.push(issue(
            'evidence_policy_violation',
            thread.path,
            `Done evidence does not satisfy policy "${policy}".`,
            {
              policy,
              validEvidence: validation.validEvidence.map((entry) => ({ type: entry.type, value: entry.value })),
              invalidEvidence: validation.invalidEvidence.map((entry) => ({
                type: entry.type,
                value: entry.value,
                reason: entry.reason,
              })),
            },
          ));
        }
      }

      const descendantGate = gate.checkRequiredDescendants(workspacePath, thread.path);
      if (!descendantGate.ok) {
        violations.push(issue(
          'dependency_gate_violation',
          thread.path,
          descendantGate.message,
          {
            unresolvedDescendants: descendantGate.unresolvedDescendants,
          },
        ));
      }
    }

    if (terminalLock) {
      const lockIssues = checkTerminalLockHistory(thread.path, history);
      violations.push(...lockIssues);
    }
  }

  for (const entry of entries) {
    const threadTarget = normalizeThreadTarget(entry);
    if (!threadTarget) continue;
    if (threadByPath.has(threadTarget)) continue;
    violations.push(issue(
      'orphan_ledger_entry',
      threadTarget,
      `Ledger entry ${entry.op} references missing thread target "${threadTarget}".`,
      {
        ts: entry.ts,
        actor: entry.actor,
        op: entry.op,
      },
    ));
  }

  return {
    violations,
    warnings,
    ok: violations.length === 0,
  };
}

function checkTerminalLockHistory(threadPath: string, history: LedgerEntry[]): ReconcileIssue[] {
  const issues: ReconcileIssue[] = [];
  let lockActive = false;

  for (const entry of history) {
    if (entry.op === 'done') {
      lockActive = true;
      continue;
    }

    if (!lockActive) continue;
    if (entry.op === 'reopen') {
      const reason = String(entry.data?.reason ?? '').trim();
      if (!reason) {
        issues.push(issue(
          'reopen_missing_reason',
          threadPath,
          'Reopen entry is missing required reason after done terminal state.',
          { ts: entry.ts },
        ));
      }
      lockActive = false;
      continue;
    }
    if (entry.op === 'rejected') {
      continue;
    }
    if (entry.op === 'update' && String(entry.data?.to_status ?? '') === 'done') {
      continue;
    }

    issues.push(issue(
      'terminal_lock_violation',
      threadPath,
      `Operation "${entry.op}" occurred after done without reopen.`,
      {
        ts: entry.ts,
        actor: entry.actor,
      },
    ));
  }

  return issues;
}

function parseLedgerEvidence(raw: unknown): ReturnType<typeof collectThreadEvidence> {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const inputs: ThreadEvidenceInput[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      inputs.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const value = 'value' in item ? String((item as { value?: unknown }).value ?? '').trim() : '';
    if (!value) continue;
    const rawType = 'type' in item ? String((item as { type?: unknown }).type ?? '').trim() : undefined;
    const type = normalizeEvidenceType(rawType);
    inputs.push(type ? { type, value } : { value });
  }
  return collectThreadEvidence(undefined, inputs);
}

function normalizeEvidenceType(value: string | undefined): ThreadEvidenceType | undefined {
  switch (value) {
    case 'url':
    case 'attachment':
    case 'thread-ref':
    case 'reply-ref':
      return value;
    default:
      return undefined;
  }
}

function normalizeStatus(value: unknown): ThreadStatus | null {
  const status = String(value ?? '').trim() as ThreadStatus;
  return THREAD_STATUSES.includes(status) ? status : null;
}

function deriveStatusFromLedger(history: LedgerEntry[]): ThreadStatus | null {
  let status: ThreadStatus | null = null;
  for (const entry of history) {
    switch (entry.op) {
      case 'create': {
        const createdStatus = normalizeStatus(entry.data?.status);
        status = createdStatus ?? 'open';
        break;
      }
      case 'claim':
      case 'unblock':
        status = 'active';
        break;
      case 'block':
        status = 'blocked';
        break;
      case 'done':
        status = 'done';
        break;
      case 'cancel':
        status = 'cancelled';
        break;
      case 'release':
      case 'reopen':
        status = 'open';
        break;
      case 'update': {
        const toStatus = normalizeStatus(entry.data?.to_status);
        if (toStatus) status = toStatus;
        break;
      }
      default:
        break;
    }
  }
  return status;
}

function normalizeThreadTarget(entry: LedgerEntry): string | null {
  if (entry.type === 'thread') return entry.target;
  const target = String(entry.target ?? '');
  if (!target.startsWith('threads/')) return null;
  if (!target.endsWith('.md')) return `${target}.md`;
  return target;
}

function issue(
  code: string,
  target: string,
  message: string,
  details?: Record<string, unknown>,
): ReconcileIssue {
  return {
    code,
    target,
    message,
    ...(details ? { details } : {}),
  };
}

function isKebabCase(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function fileSlug(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? '';
  return basename.endsWith('.md') ? basename.slice(0, -3) : basename;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return fallback;
}
