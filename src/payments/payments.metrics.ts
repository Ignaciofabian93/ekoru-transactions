import type { Queue } from 'bullmq';
import { Counter, Gauge, register } from 'prom-client';

const OUTCOMES = 'ekoru_payments_total';
const QUEUE_DEPTH = 'ekoru_payments_queue_depth';

let outcomes: Counter<'provider' | 'type' | 'status'> | undefined;

/**
 * Counts payments as providers settle them, by provider, payment type and
 * status (INF-5): the "failed payments" alert reads it. Kept as a module-level
 * counter so recording one needs no extra injection.
 */
export function recordPaymentOutcome(labels: {
  provider: string;
  type: string;
  status: string;
}): void {
  if (!outcomes) {
    register.removeSingleMetric(OUTCOMES);
    outcomes = new Counter({
      name: OUTCOMES,
      help: 'Payments settled by a provider, by provider, payment type and status',
      labelNames: ['provider', 'type', 'status'] as const,
    });
  }
  outcomes.inc(labels);
}

/**
 * Jobs in the payments queue by state, read at scrape time (INF-5). A worker
 * that is dead runs no job, so only a number read when scraped shows its
 * backlog growing; the same reasoning as ekoru-users' notification queue.
 */
export function registerPaymentQueueGauge(queue: Queue): void {
  register.removeSingleMetric(QUEUE_DEPTH);
  new Gauge({
    name: QUEUE_DEPTH,
    help: 'Payment jobs (refunds, stock, quotations, sweeps) in the queue, by state',
    labelNames: ['state'] as const,
    async collect() {
      try {
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
        );
        for (const [state, value] of Object.entries(counts)) {
          this.set({ state }, value ?? 0);
        }
      } catch {
        // Redis unreachable: report nothing rather than a stale number.
        this.reset();
      }
    },
  });
}
