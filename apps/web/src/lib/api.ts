'use client';

import type { ProblemDetails } from '@nextdoo/contracts';

/** Thrown for any non-2xx API response, carrying the RFC 7807 payload. */
export class ApiError extends Error {
  readonly problem: ProblemDetails;
  constructor(problem: ProblemDetails) {
    super(problem.detail);
    this.name = 'ApiError';
    this.problem = problem;
  }
  get code() { return this.problem.code; }
  get isConflict() { return this.problem.code === 'RESOURCE_VERSION_CONFLICT'; }
  get isLimit() { return this.problem.code === 'ENTITLEMENT_LIMIT_REACHED'; }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase()) && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', crypto.randomUUID());
  const response = await fetch(`/api/v1${path}`, { ...init, headers });

  if (response.status === 204) return undefined as T;

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      (body as ProblemDetails) ?? {
        type: 'about:blank',
        title: 'Request failed',
        status: response.status,
        code: 'INTERNAL_ERROR',
        detail: 'The server could not be reached.',
      },
    );
  }
  return body as T;
}

export interface Task {
  id: string;
  workspaceId: string;
  projectId: string | null;
  sectionId?: string | null;
  parentTaskId?: string | null;
  title: string;
  description: string | null;
  status: 'ACTIVE' | 'COMPLETED' | 'ARCHIVED' | 'DELETED';
  priority: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  dueAt: string | null;
  estimateMinutes: number | null;
  actualMinutes: number;
  actualSeconds: number;
  rescheduleCount: number;
  version: number;
  completedAt: string | null;
  deletedAt?: string | null;
  restoreUntil?: string | null;
  createdAt: string;
}
