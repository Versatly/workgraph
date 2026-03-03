import fs from 'node:fs';
import path from 'node:path';
import type { PolicyParty, PolicyRegistry } from './types.js';

const POLICY_FILE = '.workgraph/policy.json';
const POLICY_VERSION = 1;

export function policyPath(workspacePath: string): string {
  return path.join(workspacePath, POLICY_FILE);
}

export function loadPolicyRegistry(workspacePath: string): PolicyRegistry {
  const targetPath = policyPath(workspacePath);
  if (!fs.existsSync(targetPath)) {
    const seeded = seedPolicyRegistry();
    savePolicyRegistry(workspacePath, seeded);
    return seeded;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as Partial<PolicyRegistry>;
    if (!parsed.version || !parsed.parties) {
      return seedPolicyRegistry();
    }
    return parsed as PolicyRegistry;
  } catch {
    return seedPolicyRegistry();
  }
}

export function savePolicyRegistry(workspacePath: string, registry: PolicyRegistry): void {
  const targetPath = policyPath(workspacePath);
  const directory = path.dirname(targetPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(targetPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
}

export function upsertParty(
  workspacePath: string,
  partyId: string,
  updates: {
    roles?: string[];
    capabilities?: string[];
  },
): PolicyParty {
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
  return next;
}

export function getParty(workspacePath: string, partyId: string): PolicyParty | null {
  const registry = loadPolicyRegistry(workspacePath);
  return registry.parties[partyId] ?? null;
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
