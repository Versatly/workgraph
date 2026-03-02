import * as policy from '../policy.js';
import type { WorkgraphMcpServerOptions } from './types.js';

export function resolveActor(actor: string | undefined, defaultActor: string | undefined): string {
  const resolved = actor ?? defaultActor ?? 'anonymous';
  return String(resolved);
}

export function checkWriteGate(
  options: WorkgraphMcpServerOptions,
  actor: string,
  requiredCapabilities: string[],
): { allowed: true } | { allowed: false; reason: string } {
  if (options.readOnly) {
    return {
      allowed: false,
      reason: 'MCP server is configured read-only; write tool is disabled.',
    };
  }

  if (actor === 'system') {
    return { allowed: true };
  }

  const party = policy.getParty(options.workspacePath, actor);
  if (!party) {
    return {
      allowed: false,
      reason: `Policy gate blocked MCP write: actor "${actor}" is not a registered party.`,
    };
  }

  const hasCapability = requiredCapabilities.some((capability) => party.capabilities.includes(capability));
  if (!hasCapability) {
    return {
      allowed: false,
      reason: `Policy gate blocked MCP write: actor "${actor}" lacks capabilities [${requiredCapabilities.join(', ')}].`,
    };
  }

  return { allowed: true };
}
