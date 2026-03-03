import type { GateCheckDecision } from './contracts.js';
import { getParty } from './registry.js';

const SENSITIVE_TYPES = new Set(['decision', 'policy', 'incident', 'trigger']);

export function canTransitionStatus(
  workspacePath: string,
  actor: string,
  primitiveType: string,
  fromStatus: string | undefined,
  toStatus: string | undefined,
): GateCheckDecision {
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
  const hasCapability = requiredCapabilities.some((capability) => party.capabilities.includes(capability));
  if (!hasCapability) {
    return {
      allowed: false,
      reason: `Policy gate blocked transition ${primitiveType}:${fromStatus}->${toStatus}; actor "${actor}" lacks required capabilities (${requiredCapabilities.join(' or ')}).`,
    };
  }

  return { allowed: true };
}
