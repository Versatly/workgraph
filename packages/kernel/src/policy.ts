/**
 * Policy registry and status transition gates.
 */

import path from 'node:path';
import fs from './storage-fs.js';
import * as auth from './auth.js';
import * as ledger from './ledger.js';
import type { PolicyParty, PolicyRegistry } from './types.js';

const POLICY_FILE = '.workgraph/policy.json';
const POLICY_VERSION = 1;
const SENSITIVE_TYPES = new Set(['decision', 'policy', 'incident', 'trigger']);

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

export function policyPath(workspacePath: string): string {
  return path.join(workspacePath, POLICY_FILE);
}

export function loadPolicyRegistry(workspacePath: string): PolicyRegistry {
  const pPath = policyPath(workspacePath);
  if (!fs.existsSync(pPath)) {
    const seeded = seedPolicyRegistry();
    savePolicyRegistry(workspacePath, seeded);
    return seeded;
  }

  try {
    const raw = fs.readFileSync(pPath, 'utf-8');
    const parsed = JSON.parse(raw) as PolicyRegistry;
    if (!parsed.version || !parsed.parties) {
      return seedPolicyRegistry();
    }
    return parsed;
  } catch {
    return seedPolicyRegistry();
  }
}

export function savePolicyRegistry(workspacePath: string, registry: PolicyRegistry): void {
  const pPath = policyPath(workspacePath);
  const dir = path.dirname(pPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
}

export function upsertParty(
  workspacePath: string,
  partyId: string,
  updates: {
    roles?: string[];
    capabilities?: string[];
  },
  options: {
    actor?: string;
    skipAuthorization?: boolean;
  } = {},
): PolicyParty {
  const actor = String(options.actor ?? 'system').trim() || 'system';
  if (!options.skipAuthorization) {
    auth.assertAuthorizedMutation(workspacePath, {
      actor,
      action: 'policy.party.upsert',
      target: `.workgraph/policy.json#party/${partyId}`,
      requiredCapabilities: ['policy:manage', 'agent:register'],
      allowSystemActor: true,
      metadata: {
        module: 'policy',
        party_id: partyId,
      },
    });
  }
  const registry = loadPolicyRegistry(workspacePath);
  const now = new Date().toISOString();
  const existing = registry.parties[partyId];
  const next: PolicyParty = {
    id: partyId,
    roles: updates.roles ?? existing?.roles ?? [],
    capabilities: updates.capabilities ?? existing?.capabilities ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  registry.parties[partyId] = next;
  savePolicyRegistry(workspacePath, registry);
  ledger.append(
    workspacePath,
    actor,
    existing ? 'update' : 'create',
    `.workgraph/policy.json#party/${partyId}`,
    'policy-party',
    {
      party_id: partyId,
      roles: next.roles,
      capabilities: next.capabilities,
      ...(existing ? { replaced: true } : { replaced: false }),
    },
  );
  return next;
}

export function getParty(workspacePath: string, partyId: string): PolicyParty | null {
  const registry = loadPolicyRegistry(workspacePath);
  return registry.parties[partyId] ?? null;
}

export function canTransitionStatus(
  workspacePath: string,
  actor: string,
  primitiveType: string,
  fromStatus: string | undefined,
  toStatus: string | undefined,
): PolicyDecision {
  if (!fromStatus || !toStatus || fromStatus === toStatus) {
    return { allowed: true };
  }

  if (!SENSITIVE_TYPES.has(primitiveType)) {
    return { allowed: true };
  }

  if (actor === 'system') {
    return { allowed: true };
  }

  const needsPromotionCapability = ['approved', 'active'].includes(toStatus);
  if (!needsPromotionCapability) {
    return { allowed: true };
  }

  const party = getParty(workspacePath, actor);
  if (!party) {
    return {
      allowed: false,
      reason: `Policy gate blocked transition ${primitiveType}:${fromStatus}->${toStatus}; actor "${actor}" is not a registered party.`,
    };
  }

  const requiredCapabilities = [
    `promote:${primitiveType}`,
    'promote:sensitive',
  ];
  const hasCapability = requiredCapabilities.some((cap) => party.capabilities.includes(cap));
  if (!hasCapability) {
    return {
      allowed: false,
      reason: `Policy gate blocked transition ${primitiveType}:${fromStatus}->${toStatus}; actor "${actor}" lacks required capabilities (${requiredCapabilities.join(' or ')}).`,
    };
  }

  return { allowed: true };
}

function seedPolicyRegistry(): PolicyRegistry {
  const now = new Date().toISOString();
  return {
    version: POLICY_VERSION,
    parties: {
      system: {
        id: 'system',
        roles: ['admin'],
        capabilities: ['promote:sensitive', 'dispatch:run', 'policy:manage'],
        createdAt: now,
        updatedAt: now,
      },
    },
  };
}
