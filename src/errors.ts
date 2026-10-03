export type StuErrorCode =
  | 'UNSUPPORTED_BROWSER'
  | 'PERMISSION_DENIED'
  | 'DEVICE_BUSY'
  | 'DISCONNECTED'
  | 'UNSUPPORTED_FEATURE'
  | 'INVALID_ARGUMENT'
  | 'MALFORMED_REPORT'
  | 'DEVICE_STATUS'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'ENCRYPTION'
  | 'CAPTURE_OVERFLOW'
  | 'INVALID_STATE'
  | 'TRANSPORT';

export interface ErrorDetails {
  readonly operation?: string;
  readonly reportId?: number;
  readonly status?: number;
  readonly cause?: unknown;
}

/** Safe metadata only: errors never contain pen data, PINs, or key material. */
export class StuError extends Error {
  readonly code: StuErrorCode;
  readonly operation: string | undefined;
  readonly reportId: number | undefined;
  readonly status: number | undefined;

  constructor(code: StuErrorCode, message: string, details: ErrorDetails = {}) {
    super(message, { cause: details.cause });
    this.name = 'StuError';
    this.code = code;
    this.operation = details.operation;
    this.reportId = details.reportId;
    this.status = details.status;
  }
}

export function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new StuError('INVALID_ARGUMENT', `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new StuError('INVALID_ARGUMENT', message);
}

export function boolean(value: boolean, name: string): boolean {
  invariant(typeof value === 'boolean', `${name} must be a boolean`);
  return value;
}

export function asStuError(error: unknown, operation: string): StuError {
  return error instanceof StuError
    ? error
    : new StuError('TRANSPORT', `${operation} failed`, { operation, cause: error });
}
