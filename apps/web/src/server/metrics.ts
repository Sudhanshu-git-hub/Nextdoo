import { logger } from './observability';

/**
 * M2 product instrumentation (PRD §21.3 Milestone 2: "capture latency ·
 * task creation success rate · task mutation error rate · active-task
 * count", §20.3 metric definitions, §19.4 observability gate).
 *
 * Architecture: these are typed metric events emitted through the existing
 * structured-log sink (single-line JSON with request/workspace context, the
 * same shape an OTel collector or log shipper consumes — see
 * `observability.ts`). No new infrastructure is introduced; a real
 * deployment points the sink at its metrics pipeline.
 *
 * Privacy: metric events never carry task content (titles, descriptions,
 * due text) — only identifiers, counters, durations and codes. Client
 * capture telemetry is schema-strict and content-free by construction.
 */

export type MetricSink = (event: string, context: Record<string, unknown>) => void;

const defaultSink: MetricSink = (event, context) => logger.info(event, context);
let sink: MetricSink = defaultSink;

/** Test/collector hook; pass null to restore the structured-log sink. */
export function setMetricSink(next: MetricSink | null): void {
  sink = next ?? defaultSink;
}

function emit(event: string, context: Record<string, unknown> = {}): void {
  try {
    sink(event, context);
  } catch {
    // Metrics must never break the request path.
  }
}

export type MutationChannel = 'http' | 'sync';
export type TaskMutationOperation =
  | 'update'
  | 'complete'
  | 'reopen'
  | 'reschedule'
  | 'archive'
  | 'restore'
  | 'delete';

/** Task creation success rate: `task.created` vs `task.create_failed`. */
export function recordTaskCreated(workspaceId: string, durationMs: number, via: MutationChannel): void {
  emit('task.created', { workspaceId, durationMs, via });
}

export function recordTaskCreateFailed(workspaceId: string, code: string, via: MutationChannel): void {
  emit('task.create_failed', { workspaceId, code, via });
}

/** Task mutation error rate: `task.mutated` vs `task.mutation_failed`. */
export function recordTaskMutated(workspaceId: string, operation: TaskMutationOperation, durationMs: number, via: MutationChannel): void {
  emit('task.mutated', { workspaceId, operation, durationMs, via });
}

export function recordTaskMutationFailed(workspaceId: string, operation: TaskMutationOperation, code: string, via: MutationChannel): void {
  emit('task.mutation_failed', { workspaceId, operation, code, via });
}

/** Active-task count gauge (emitted after count-changing mutations). */
export function recordActiveTaskCount(workspaceId: string, activeTasks: number): void {
  emit('workspace.active_tasks', { workspaceId, activeTasks });
}

/**
 * Capture latency (PRD §20.3: time from capture UI open to saved task),
 * measured client-side in QuickCapture. Content-free by schema.
 */
export function recordCapture(latencyMs: number, success: boolean, confirmed: boolean): void {
  emit('task.capture', { latencyMs, success, confirmed });
}

/**
 * Times a domain mutation and emits the success/failure metric event.
 * `operation` is 'create' for creation or the mutation operation name; the
 * optional gauge callback runs only after a successful, count-changing
 * mutation and must swallow its own errors (it must never fail the request).
 */
export async function withTaskMetric<T>(
  workspaceId: string,
  via: MutationChannel,
  operation: 'create' | TaskMutationOperation,
  fn: () => Promise<T>,
  gaugeOnSuccess?: () => Promise<void>,
): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    if (operation === 'create') recordTaskCreated(workspaceId, Math.round(performance.now() - started), via);
    else recordTaskMutated(workspaceId, operation, Math.round(performance.now() - started), via);
    if (gaugeOnSuccess) await gaugeOnSuccess();
    return result;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'INTERNAL_ERROR';
    if (operation === 'create') recordTaskCreateFailed(workspaceId, code, via);
    else recordTaskMutationFailed(workspaceId, operation, code, via);
    throw error;
  }
}
