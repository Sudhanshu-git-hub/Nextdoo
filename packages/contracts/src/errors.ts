/**
 * Canonical error codes and RFC 7807-style problem details.
 * PRD §14.2 — every API failure must serialise to this shape.
 */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  /** Password accepted, but a second factor is still outstanding. */
  'MFA_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RESOURCE_VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'DEPENDENCY_CYCLE',
  'ENTITLEMENT_LIMIT_REACHED',
  'RATE_LIMITED',
  /** An export job has not finished generating yet. */
  'EXPORT_NOT_READY',
  /** An export's 24-hour download window has elapsed. */
  'EXPORT_EXPIRED',
  /** The attachment has not reached a CLEAN scan status (PRD §6.8). */
  'ATTACHMENT_NOT_CLEAN',
  'PROVIDER_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RESOURCE_VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  DEPENDENCY_CYCLE: 422,
  ENTITLEMENT_LIMIT_REACHED: 402,
  RATE_LIMITED: 429,
  EXPORT_NOT_READY: 409,
  EXPORT_EXPIRED: 410,
  ATTACHMENT_NOT_CLEAN: 409,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

const TITLE_BY_CODE: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'Validation failed',
  UNAUTHENTICATED: 'Authentication required',
  MFA_REQUIRED: 'Two-factor code required',
  FORBIDDEN: 'Not permitted',
  NOT_FOUND: 'Resource not found',
  RESOURCE_VERSION_CONFLICT: 'Version conflict',
  IDEMPOTENCY_CONFLICT: 'Idempotency conflict',
  DEPENDENCY_CYCLE: 'Dependency cycle',
  ENTITLEMENT_LIMIT_REACHED: 'Plan limit reached',
  RATE_LIMITED: 'Too many requests',
  EXPORT_NOT_READY: 'Export not ready',
  EXPORT_EXPIRED: 'Export expired',
  ATTACHMENT_NOT_CLEAN: 'Attachment not clean',
  PROVIDER_UNAVAILABLE: 'Upstream provider unavailable',
  INTERNAL_ERROR: 'Internal error',
};

export interface ProblemResource {
  type: string;
  id: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail: string;
  request_id?: string;
  resource?: ProblemResource;
  errors?: Array<{ path: string; message: string }>;
}

export const PROBLEM_BASE_URI = 'https://api.nextdoo.example/errors/';

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

/**
 * Domain-level error carrying a stable machine code.
 * Never place secrets or task content in `detail` — it is user-visible and logged (PRD §11.4).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly resource?: ProblemResource;
  readonly fieldErrors?: Array<{ path: string; message: string }>;

  constructor(
    code: ErrorCode,
    detail: string,
    options?: { resource?: ProblemResource; fieldErrors?: Array<{ path: string; message: string }>; cause?: unknown },
  ) {
    super(detail, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.resource = options?.resource;
    this.fieldErrors = options?.fieldErrors;
  }

  toProblem(requestId?: string): ProblemDetails {
    const problem: ProblemDetails = {
      type: `${PROBLEM_BASE_URI}${this.code.toLowerCase().replaceAll('_', '-')}`,
      title: TITLE_BY_CODE[this.code],
      status: this.status,
      code: this.code,
      detail: this.message,
    };
    if (requestId) problem.request_id = requestId;
    if (this.resource) problem.resource = this.resource;
    if (this.fieldErrors?.length) problem.errors = this.fieldErrors;
    return problem;
  }
}

export const unauthenticated = (detail = 'Authentication is required.') => new AppError('UNAUTHENTICATED', detail);
export const forbidden = (detail = 'You do not have access to this resource.') => new AppError('FORBIDDEN', detail);
export const notFound = (type: string, id: string) =>
  new AppError('NOT_FOUND', 'The requested resource does not exist.', { resource: { type, id } });
export const versionConflict = (type: string, id: string) =>
  new AppError('RESOURCE_VERSION_CONFLICT', 'The resource was changed on another device.', {
    resource: { type, id },
  });
