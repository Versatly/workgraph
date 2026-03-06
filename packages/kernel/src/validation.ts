import {
  InputValidationError,
  type WorkgraphErrorContext,
} from './errors.js';

const RUN_ID_PATTERN = /^run_[a-z0-9-]{8,}$/i;
const THREAD_PATH_PATTERN = /^threads\/[a-z0-9._/-]+\.md$/i;
const ACTOR_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/i;

export function validateWorkspacePath(
  workspacePath: string,
  context: WorkgraphErrorContext = {},
): string {
  const normalized = String(workspacePath ?? '').trim();
  if (!normalized) {
    throw new InputValidationError('workspacePath is required.', context);
  }
  return normalized;
}

export function validateActorName(
  actor: string,
  context: WorkgraphErrorContext = {},
): string {
  const normalized = String(actor ?? '').trim();
  if (!normalized) {
    throw new InputValidationError('Actor name is required.', context);
  }
  if (!ACTOR_PATTERN.test(normalized)) {
    throw new InputValidationError(
      `Actor name "${normalized}" is invalid. Use 2-128 characters [a-z0-9._-], starting with [a-z0-9].`,
      context,
    );
  }
  return normalized;
}

export function validateRunId(
  runId: string,
  context: WorkgraphErrorContext = {},
): string {
  const normalized = String(runId ?? '').trim();
  if (!normalized) {
    throw new InputValidationError('Run ID is required.', context);
  }
  if (!RUN_ID_PATTERN.test(normalized)) {
    throw new InputValidationError(`Run ID "${normalized}" is invalid.`, context);
  }
  return normalized;
}

export function validateThreadPath(
  threadPath: string,
  context: WorkgraphErrorContext = {},
): string {
  const normalized = String(threadPath ?? '').trim();
  if (!normalized) {
    throw new InputValidationError('Thread path is required.', context);
  }
  if (!THREAD_PATH_PATTERN.test(normalized)) {
    throw new InputValidationError(`Thread path "${normalized}" is invalid.`, context);
  }
  return normalized;
}

export function validateObjective(
  objective: string,
  context: WorkgraphErrorContext = {},
): string {
  const normalized = String(objective ?? '').trim();
  if (!normalized) {
    throw new InputValidationError('Dispatch objective is required.', context);
  }
  if (normalized.length > 10_000) {
    throw new InputValidationError('Dispatch objective exceeds max length (10000).', context);
  }
  return normalized;
}

export function validateIdempotencyKey(
  idempotencyKey: string | undefined,
  context: WorkgraphErrorContext = {},
): string | undefined {
  if (idempotencyKey === undefined) return undefined;
  const normalized = String(idempotencyKey).trim();
  if (!normalized) {
    throw new InputValidationError('idempotencyKey cannot be empty when provided.', context);
  }
  if (normalized.length > 512) {
    throw new InputValidationError('idempotencyKey exceeds max length (512).', context);
  }
  return normalized;
}
