export type WorkgraphErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'CONCURRENCY'
  | 'STATE_CORRUPTION'
  | 'SUBSYSTEM_FAILURE'
  | 'OPERATION_FAILED';

export interface WorkgraphErrorContext {
  workspacePath?: string;
  threadPath?: string;
  actor?: string;
  runId?: string;
  target?: string;
  operation?: string;
  details?: Record<string, unknown>;
}

export class WorkgraphError extends Error {
  code: WorkgraphErrorCode;
  context: WorkgraphErrorContext;

  constructor(
    code: WorkgraphErrorCode,
    message: string,
    context: WorkgraphErrorContext = {},
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'WorkgraphError';
    this.code = code;
    this.context = context;
    if ('cause' in Error.prototype) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class InputValidationError extends WorkgraphError {
  constructor(message: string, context: WorkgraphErrorContext = {}, options: { cause?: unknown } = {}) {
    super('INVALID_INPUT', message, context, options);
    this.name = 'InputValidationError';
  }
}

export class ResourceNotFoundError extends WorkgraphError {
  constructor(message: string, context: WorkgraphErrorContext = {}, options: { cause?: unknown } = {}) {
    super('NOT_FOUND', message, context, options);
    this.name = 'ResourceNotFoundError';
  }
}

export class ConflictError extends WorkgraphError {
  constructor(message: string, context: WorkgraphErrorContext = {}, options: { cause?: unknown } = {}) {
    super('CONFLICT', message, context, options);
    this.name = 'ConflictError';
  }
}

export class ConcurrencyError extends WorkgraphError {
  constructor(message: string, context: WorkgraphErrorContext = {}, options: { cause?: unknown } = {}) {
    super('CONCURRENCY', message, context, options);
    this.name = 'ConcurrencyError';
  }
}

export class StateCorruptionError extends WorkgraphError {
  constructor(message: string, context: WorkgraphErrorContext = {}, options: { cause?: unknown } = {}) {
    super('STATE_CORRUPTION', message, context, options);
    this.name = 'StateCorruptionError';
  }
}

export class SubsystemFailureError extends WorkgraphError {
  constructor(message: string, context: WorkgraphErrorContext = {}, options: { cause?: unknown } = {}) {
    super('SUBSYSTEM_FAILURE', message, context, options);
    this.name = 'SubsystemFailureError';
  }
}

export class OperationFailedError extends WorkgraphError {
  constructor(message: string, context: WorkgraphErrorContext = {}, options: { cause?: unknown } = {}) {
    super('OPERATION_FAILED', message, context, options);
    this.name = 'OperationFailedError';
  }
}

export function asWorkgraphError(
  error: unknown,
  fallbackMessage: string,
  context: WorkgraphErrorContext = {},
): WorkgraphError {
  if (error instanceof WorkgraphError) return error;
  const message = error instanceof Error && error.message ? error.message : fallbackMessage;
  return new OperationFailedError(message, context, { cause: error });
}
