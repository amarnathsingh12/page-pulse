export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNSUPPORTED_TARGET'
  | 'BLOCKED_TARGET'
  | 'RATE_LIMITED'
  | 'OVER_CAPACITY'
  | 'NOT_READY'
  | 'INTERNAL_ERROR';

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = code;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class UnsupportedTargetError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(422, 'UNSUPPORTED_TARGET', message, details);
  }
}

export class BlockedTargetError extends AppError {
  constructor(message = 'Target resolves to a disallowed address.') {
    super(403, 'BLOCKED_TARGET', message);
  }
}

export class RateLimitedError extends AppError {
  readonly retryAfter: number;
  constructor(retryAfter: number, details?: Record<string, unknown>) {
    super(429, 'RATE_LIMITED', 'Rate limit exceeded.', details);
    this.retryAfter = retryAfter;
  }
}

export class OverCapacityError extends AppError {
  readonly retryAfter: number;
  constructor(retryAfter = 5) {
    super(503, 'OVER_CAPACITY', 'Server is at capacity. Retry shortly.');
    this.retryAfter = retryAfter;
  }
}

export class NotReadyError extends AppError {
  constructor(check: string) {
    super(503, 'NOT_READY', 'Service not ready.', { check });
  }
}

export function toErrorEnvelope(err: unknown, requestId: string): ErrorEnvelope {
  if (err instanceof AppError) {
    return {
      error: { code: err.code, message: err.message, requestId, details: err.details },
    };
  }
  return {
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId },
  };
}

export function statusForError(err: unknown): number {
  return err instanceof AppError ? err.statusCode : 500;
}
