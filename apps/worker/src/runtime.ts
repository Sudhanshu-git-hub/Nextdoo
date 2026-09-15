import { createDb, type Database } from '@nextdoo/db';

/**
 * Minimal worker runtime: database access, structured logging and a scheduler.
 *
 * The worker deliberately does not import from `apps/web`. Sharing a process
 * boundary's internals would couple deployment of the two, and the worker needs
 * to keep running while the web app restarts.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required to start the worker.');
}

if (process.env.SMTP_URL && (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32)) {
  throw new Error('AUTH_SECRET (32+ characters) is required for encrypted mail delivery.');
}

// A small pool: jobs are sequential and long-lived connections are wasteful.
const connection = createDb(DATABASE_URL, { max: 4 });

export const db: Database = connection.db;
export const sql = connection.sql;

type Level = 'debug' | 'info' | 'warn' | 'error';

export const logger = {
  log(level: Level, message: string, fields: Record<string, unknown> = {}) {
    // Same JSON shape as the web app so both streams can be queried together.
    process.stdout.write(
      `${JSON.stringify({ level, message, timestamp: new Date().toISOString(), service: 'worker', ...fields })}\n`,
    );
  },
  debug: (m: string, f?: Record<string, unknown>) => logger.log('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => logger.log('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => logger.log('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => logger.log('error', m, f),
};

export interface Job {
  name: string;
  /** How often to run, in milliseconds. */
  intervalMs: number;
  run: () => Promise<JobResult>;
}

export interface JobResult {
  /** Items processed, for the log line. */
  processed: number;
  details?: Record<string, unknown>;
}

let stopping = false;
const timers: ReturnType<typeof setInterval>[] = [];
const inFlight = new Set<Promise<void>>();

/**
 * Runs a job, catching everything.
 *
 * A job that throws must never take the worker down: the next tick should get a
 * clean attempt. Overlap is prevented per job, because a slow run colliding with
 * its own next tick is how duplicate side effects happen.
 */
async function runGuarded(job: Job, running: Set<string>): Promise<void> {
  if (stopping || running.has(job.name)) return;
  running.add(job.name);

  const startedAt = Date.now();
  try {
    const result = await job.run();
    if (result.processed > 0) {
      logger.info('job.completed', {
        job: job.name,
        processed: result.processed,
        durationMs: Date.now() - startedAt,
        ...result.details,
      });
    }
  } catch (error) {
    logger.error('job.failed', {
      job: job.name,
      durationMs: Date.now() - startedAt,
      errorType: error instanceof Error ? error.name : 'unknown',
    });
  } finally {
    running.delete(job.name);
  }
}

export function schedule(jobs: Job[]): void {
  const running = new Set<string>();

  for (const job of jobs) {
    // Run once at boot so a restart does not delay overdue work by a full interval.
    const launch = () => {
      const run = runGuarded(job, running);
      inFlight.add(run);
      void run.finally(() => inFlight.delete(run));
    };
    launch();
    const timer = setInterval(launch, job.intervalMs);
    // Do not hold the event loop open purely for a timer.
    timer.unref?.();
    timers.push(timer);
  }

  logger.info('worker.started', { jobs: jobs.map((j) => `${j.name}@${j.intervalMs}ms`) });
}

/** Drains timers and closes the pool so an orchestrator sees a clean exit. */
export async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info('worker.stopping', { signal });

  for (const timer of timers) clearInterval(timer);
  await Promise.allSettled([...inFlight]);
  try {
    await sql.end({ timeout: 5 });
  } catch {
    /* closing on the way out; nothing useful to do */
  }
  logger.info('worker.stopped');
}
