/**
 * Thread quality gate evaluation.
 */

import * as store from './store.js';
import * as registry from './registry.js';
import { normalizeEvidencePolicy } from './evidence.js';
import type { EvidencePolicy, PrimitiveInstance } from './types.js';

const POLICY_GATE_TYPE = 'policy-gate';
const ACTIVE_GATE_STATUSES = new Set(['active', 'approved']);

export interface GateRuleResult {
  rule: 'required-facts' | 'required-approvals' | 'min-age-seconds' | 'gate-status' | 'gate-exists' | 'required-descendants';
  ok: boolean;
  message: string;
}

export interface GateEvaluation {
  gateRef: string;
  gatePath?: string;
  gateTitle?: string;
  ok: boolean;
  rules: GateRuleResult[];
}

export interface ThreadGateCheckResult {
  checkedAt: string;
  threadPath: string;
  allowed: boolean;
  gates: GateEvaluation[];
}

export interface DescendantGateResult {
  ok: boolean;
  threadPath: string;
  unresolvedDescendants: string[];
  message: string;
}

export function checkThreadGates(
  workspacePath: string,
  threadRef: string,
  now: Date = new Date(),
): ThreadGateCheckResult {
  const threadPath = resolveThreadRef(threadRef);
  const thread = store.read(workspacePath, threadPath);
  if (!thread) {
    throw new Error(`Thread not found: ${threadPath}`);
  }
  if (thread.type !== 'thread') {
    throw new Error(`Target is not a thread primitive: ${threadPath}`);
  }

  const gateRefs = asStringList(thread.fields.gates);
  if (gateRefs.length === 0) {
    return {
      checkedAt: now.toISOString(),
      threadPath,
      allowed: true,
      gates: [],
    };
  }

  const facts = store.list(workspacePath, 'fact');
  const factsByPath = new Set(facts.map((fact) => fact.path));
  const threadApprovals = new Set(asStringList(thread.fields.approvals));
  const evaluations = gateRefs.map((gateRef) =>
    evaluateOneGate(workspacePath, gateRef, thread, facts, factsByPath, threadApprovals, now));

  return {
    checkedAt: now.toISOString(),
    threadPath,
    allowed: evaluations.every((gate) => gate.ok),
    gates: evaluations,
  };
}

export function summarizeGateFailures(result: ThreadGateCheckResult): string {
  const failing = result.gates.filter((gate) => !gate.ok);
  if (failing.length === 0) {
    return `All gates passed for ${result.threadPath}.`;
  }

  const fragments = failing.map((gate) => {
    const failingRules = gate.rules.filter((rule) => !rule.ok).map((rule) => rule.message);
    const label = gate.gatePath ?? gate.gateRef;
    return `${label}: ${failingRules.join('; ')}`;
  });
  return `Quality gates blocked claim for ${result.threadPath}: ${fragments.join(' | ')}`;
}

export function resolveThreadEvidencePolicy(
  workspacePath: string,
  threadRefOrInstance: string | PrimitiveInstance,
): EvidencePolicy {
  const threadPath = typeof threadRefOrInstance === 'string'
    ? resolveThreadRef(threadRefOrInstance)
    : threadRefOrInstance.path;
  const thread = typeof threadRefOrInstance === 'string'
    ? store.read(workspacePath, threadPath)
    : threadRefOrInstance;
  if (!thread) {
    throw new Error(`Thread not found: ${threadPath}`);
  }

  const policies = asStringList(thread.fields.gates)
    .map((gateRef) => resolveGateRef(workspacePath, gateRef))
    .map((gatePath) => store.read(workspacePath, gatePath))
    .filter((gate): gate is PrimitiveInstance => !!gate)
    .map((gate) => normalizeEvidencePolicy(gate.fields.evidencePolicy ?? gate.fields.evidence_policy));

  if (policies.includes('strict')) return 'strict';
  if (policies.includes('relaxed')) return 'relaxed';
  if (policies.includes('none')) return 'none';
  return 'strict';
}

export function checkRequiredDescendants(
  workspacePath: string,
  threadRef: string,
): DescendantGateResult {
  const threadPath = resolveThreadRef(threadRef);
  const thread = store.read(workspacePath, threadPath);
  if (!thread) {
    throw new Error(`Thread not found: ${threadPath}`);
  }

  const descendants = listDescendants(workspacePath, thread.path);
  const unresolvedDescendants = descendants
    .filter((candidate) => !['done', 'cancelled'].includes(String(candidate.fields.status ?? '')))
    .map((candidate) => candidate.path);

  if (unresolvedDescendants.length === 0) {
    return {
      ok: true,
      threadPath,
      unresolvedDescendants: [],
      message: 'All descendants are done/cancelled.',
    };
  }

  return {
    ok: false,
    threadPath,
    unresolvedDescendants,
    message: `Unresolved descendants: ${unresolvedDescendants.join(', ')}`,
  };
}

function evaluateOneGate(
  workspacePath: string,
  gateRef: string,
  thread: PrimitiveInstance,
  facts: PrimitiveInstance[],
  factsByPath: Set<string>,
  threadApprovals: Set<string>,
  now: Date,
): GateEvaluation {
  const gatePath = resolveGateRef(workspacePath, gateRef);
  const gate = store.read(workspacePath, gatePath);
  if (!gate) {
    return {
      gateRef,
      gatePath,
      ok: false,
      rules: [{
        rule: 'gate-exists',
        ok: false,
        message: `Gate not found: ${gatePath}`,
      }],
    };
  }
  if (gate.type !== POLICY_GATE_TYPE) {
    return {
      gateRef,
      gatePath,
      gateTitle: String(gate.fields.title ?? gateRef),
      ok: false,
      rules: [{
        rule: 'gate-exists',
        ok: false,
        message: `Expected ${POLICY_GATE_TYPE} but found ${gate.type}`,
      }],
    };
  }

  const rules: GateRuleResult[] = [];
  const gateStatus = String(gate.fields.status ?? 'active').toLowerCase();
  rules.push({
    rule: 'gate-status',
    ok: ACTIVE_GATE_STATUSES.has(gateStatus),
    message: ACTIVE_GATE_STATUSES.has(gateStatus)
      ? `Gate status "${gateStatus}" is active.`
      : `Gate status "${gateStatus}" is not active/approved.`,
  });

  const requiredFacts = asStringList(gate.fields.required_facts);
  const missingFacts = requiredFacts.filter((requirement) =>
    !factRequirementSatisfied(requirement, facts, factsByPath, workspacePath));
  rules.push({
    rule: 'required-facts',
    ok: missingFacts.length === 0,
    message: missingFacts.length === 0
      ? `All required facts are present (${requiredFacts.length}).`
      : `Missing required facts: ${missingFacts.join(', ')}`,
  });

  const requiredApprovals = asStringList(gate.fields.required_approvals);
  const missingApprovals = requiredApprovals.filter((approval) => !threadApprovals.has(approval));
  rules.push({
    rule: 'required-approvals',
    ok: missingApprovals.length === 0,
    message: missingApprovals.length === 0
      ? `All required approvals are present (${requiredApprovals.length}).`
      : `Missing approvals: ${missingApprovals.join(', ')}`,
  });

  const minAgeSeconds = asNumber(gate.fields.min_age_seconds) ?? 0;
  const minAgeRule = evaluateMinAgeRule(thread, minAgeSeconds, now);
  rules.push(minAgeRule);

  const requiredDescendants = asBoolean(gate.fields.requiredDescendants) || asBoolean(gate.fields.required_descendants);
  if (requiredDescendants) {
    const descendantsRule = checkRequiredDescendants(workspacePath, thread.path);
    rules.push({
      rule: 'required-descendants',
      ok: descendantsRule.ok,
      message: descendantsRule.message,
    });
  } else {
    rules.push({
      rule: 'required-descendants',
      ok: true,
      message: 'Descendant completion rule is not enabled.',
    });
  }

  return {
    gateRef,
    gatePath: gate.path,
    gateTitle: String(gate.fields.title ?? gateRef),
    ok: rules.every((rule) => rule.ok),
    rules,
  };
}

function evaluateMinAgeRule(thread: PrimitiveInstance, minAgeSeconds: number, now: Date): GateRuleResult {
  if (minAgeSeconds <= 0) {
    return {
      rule: 'min-age-seconds',
      ok: true,
      message: 'No minimum age requirement configured.',
    };
  }

  const created = asDate(thread.fields.created);
  if (!created) {
    return {
      rule: 'min-age-seconds',
      ok: false,
      message: `Thread missing valid created timestamp for minimum age requirement (${minAgeSeconds}s).`,
    };
  }
  const elapsedSeconds = Math.floor((now.getTime() - created.getTime()) / 1000);
  if (elapsedSeconds >= minAgeSeconds) {
    return {
      rule: 'min-age-seconds',
      ok: true,
      message: `Minimum age requirement satisfied (${elapsedSeconds}s >= ${minAgeSeconds}s).`,
    };
  }
  return {
    rule: 'min-age-seconds',
    ok: false,
    message: `Minimum age not met. ${minAgeSeconds - elapsedSeconds}s remaining.`,
  };
}

function factRequirementSatisfied(
  requirement: string,
  facts: PrimitiveInstance[],
  factsByPath: Set<string>,
  workspacePath: string,
): boolean {
  const normalizedRequirement = requirement.trim();
  if (!normalizedRequirement) return true;

  if (normalizedRequirement.startsWith('tag:')) {
    const tagPattern = normalizedRequirement.slice(4).trim();
    if (!tagPattern) return false;
    return facts.some((fact) => factHasTagPattern(fact, tagPattern));
  }

  const factPath = resolveFactRef(workspacePath, normalizedRequirement);
  return factsByPath.has(factPath);
}

function factHasTagPattern(fact: PrimitiveInstance, pattern: string): boolean {
  const tags = asStringList(fact.fields.tags).map((entry) => entry.toLowerCase());
  if (tags.length === 0) return false;
  return tags.some((tag) => wildcardMatch(tag, pattern.toLowerCase()));
}

function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const matcher = new RegExp(`^${escaped}$`);
  return matcher.test(value);
}

function resolveThreadRef(threadRef: string): string {
  const normalized = normalizePathLike(threadRef);
  if (normalized.includes('/')) {
    return normalized;
  }
  return `threads/${normalized}`;
}

function resolveGateRef(workspacePath: string, gateRef: string): string {
  const normalized = normalizePathLike(gateRef);
  if (normalized.includes('/')) {
    return normalized;
  }
  const gateDirectory = registry.getType(workspacePath, POLICY_GATE_TYPE)?.directory ?? 'policy-gates';
  return `${gateDirectory}/${normalized}`;
}

function resolveFactRef(workspacePath: string, factRef: string): string {
  const normalized = normalizePathLike(factRef);
  if (normalized.includes('/')) {
    return normalized;
  }
  const factDirectory = registry.getType(workspacePath, 'fact')?.directory ?? 'facts';
  return `${factDirectory}/${normalized}`;
}

function normalizePathLike(value: string): string {
  const trimmed = String(value ?? '').trim();
  const unwrapped = trimmed.startsWith('[[') && trimmed.endsWith(']]')
    ? trimmed.slice(2, -2)
    : trimmed;
  return unwrapped.endsWith('.md') ? unwrapped : `${unwrapped}.md`;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp);
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  if (typeof value === 'number') return value !== 0;
  return false;
}

function listDescendants(workspacePath: string, rootThreadPath: string): PrimitiveInstance[] {
  const allThreads = store.list(workspacePath, 'thread');
  const childrenByParent = new Map<string, PrimitiveInstance[]>();
  for (const candidate of allThreads) {
    const parent = String(candidate.fields.parent ?? '').trim();
    if (!parent) continue;
    const existing = childrenByParent.get(parent) ?? [];
    existing.push(candidate);
    childrenByParent.set(parent, existing);
  }

  const visited = new Set<string>();
  const stack = [rootThreadPath];
  const descendants: PrimitiveInstance[] = [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const children = childrenByParent.get(current) ?? [];
    for (const child of children) {
      if (visited.has(child.path)) continue;
      visited.add(child.path);
      descendants.push(child);
      stack.push(child.path);
    }
  }
  return descendants;
}
