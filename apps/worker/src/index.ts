import { JOBS } from './jobs';
import { logger, schedule, shutdown } from './runtime';

/**
 * NEXTDOO background worker (PRD §15).
 *
 * Runs recurring maintenance and delivery jobs. Deployed as a separate process
 * from the web app so that slow or failing background work cannot degrade
 * request latency.
 */

schedule(JOBS);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal).then(() => process.exit(0));
  });
}

// A crashed worker that keeps running is worse than one that restarts: it looks
// healthy while silently doing nothing. Log loudly and let the supervisor act.
process.on('unhandledRejection', (reason) => {
  logger.error('worker.unhandled_rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});

process.on('uncaughtException', (error) => {
  logger.error('worker.uncaught_exception', { error: error.message });
  void shutdown('uncaughtException').then(() => process.exit(1));
});

// Keep the process alive: all job timers are unref'd.
setInterval(() => {}, 1 << 30);
