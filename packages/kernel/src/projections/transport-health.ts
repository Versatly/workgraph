import * as transport from '../transport/index.js';
import type { ProjectionSummary } from './types.js';

export interface TransportHealthProjection extends ProjectionSummary {
  scope: 'transport';
  summary: {
    outboxDepth: number;
    inboxDepth: number;
    deadLetterCount: number;
    deliverySuccessRate: number;
  };
  outbox: ReturnType<typeof transport.listTransportOutbox>;
  inbox: ReturnType<typeof transport.listTransportInbox>;
  deadLetters: ReturnType<typeof transport.listTransportDeadLetters>;
}

export function buildTransportHealthProjection(workspacePath: string): TransportHealthProjection {
  const outbox = transport.listTransportOutbox(workspacePath);
  const inbox = transport.listTransportInbox(workspacePath);
  const deadLetters = transport.listTransportDeadLetters(workspacePath);
  const deliveryAttempts = outbox.flatMap((record) => record.attempts);
  const deliveredAttempts = deliveryAttempts.filter((entry) => entry.status === 'delivered').length;
  const failedAttempts = deliveryAttempts.filter((entry) => entry.status === 'failed').length;
  const denominator = deliveredAttempts + failedAttempts;
  const deliverySuccessRate = denominator === 0 ? 100 : Math.round((deliveredAttempts / denominator) * 10_000) / 100;
  return {
    scope: 'transport',
    generatedAt: new Date().toISOString(),
    healthy: deadLetters.length === 0,
    summary: {
      outboxDepth: outbox.length,
      inboxDepth: inbox.length,
      deadLetterCount: deadLetters.length,
      deliverySuccessRate,
    },
    outbox,
    inbox,
    deadLetters,
  };
}
