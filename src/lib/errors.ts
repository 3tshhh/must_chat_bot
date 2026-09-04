/**
 * Stable, machine-readable error codes. The frontend switches on `code`,
 * never on the human-readable message.
 */
export type ErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'conversation_full'
  | 'agent_unavailable'
  | 'agent_timeout'
  | 'cancelled'
  | 'shutdown'
  | 'internal';

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  conversation_full: 409,
  agent_unavailable: 502,
  agent_timeout: 504,
  cancelled: 499,
  shutdown: 503,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown, status?: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? DEFAULT_STATUS[code];
    this.details = details;
  }

  static notFound(message = 'Not found') {
    return new AppError('not_found', message);
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError('bad_request', message, details);
  }

  static conflict(message: string) {
    return new AppError('conflict', message);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
