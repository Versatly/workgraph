import type * as orientation from '../orientation.js';

export function okResult(data: unknown, summary: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `${summary}\n\n${toPrettyJson(data)}`,
      },
    ],
    structuredContent: data as Record<string, unknown>,
  };
}

export function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: message,
      },
    ],
  };
}

export function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function renderStatusSummary(snapshot: ReturnType<typeof orientation.statusSnapshot>): string {
  return [
    `threads(total=${snapshot.threads.total}, open=${snapshot.threads.open}, active=${snapshot.threads.active}, blocked=${snapshot.threads.blocked}, done=${snapshot.threads.done})`,
    `claims(active=${snapshot.claims.active})`,
    `primitives(total=${snapshot.primitives.total})`,
  ].join(' ');
}
