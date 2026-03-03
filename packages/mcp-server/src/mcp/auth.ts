import { auth as kernelAuth } from '@versatly/workgraph-kernel';
import { type WorkgraphMcpServerOptions } from './types.js';

export function resolveActor(
  workspacePath: string,
  actor: string | undefined,
  defaultActor: string | undefined,
): string {
  if (actor) return String(actor);
  const contextToken = kernelAuth.getAuthContext()?.credentialToken;
  if (contextToken) {
    const verification = kernelAuth.verifyAgentCredential(workspacePath, contextToken, {
      touchLastUsed: false,
    });
    if (verification.valid && verification.credential) {
      return verification.credential.actor;
    }
  }
  return String(defaultActor ?? 'anonymous');
}

export function checkWriteGate(
  options: WorkgraphMcpServerOptions,
  actor: string,
  requiredCapabilities: string[],
  context: {
    action: string;
    target?: string;
  },
): { allowed: true } | { allowed: false; reason: string } {
  if (options.readOnly) {
    return {
      allowed: false,
      reason: 'MCP server is configured read-only; write tool is disabled.',
    };
  }
  const decision = kernelAuth.authorizeMutation(options.workspacePath, {
    actor,
    action: context.action,
    target: context.target,
    requiredCapabilities,
    requiredScopes: requiredCapabilities,
    allowUnauthenticatedFallback: false,
    metadata: {
      surface: 'mcp',
    },
  });
  if (!decision.allowed) {
    return {
      allowed: false,
      reason: decision.reason ?? 'Policy gate blocked MCP write.',
    };
  }
  return { allowed: true };
}
