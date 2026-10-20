import { register } from 'prom-client';
import type { Queue } from 'bullmq';
import {
  recordPaymentOutcome,
  registerPaymentQueueGauge,
} from './payments.metrics.js';

describe('payments metrics (INF-5)', () => {
  it('counts settled payments by provider, type and status', async () => {
    recordPaymentOutcome({
      provider: 'MERCADOPAGO',
      type: 'ORDER',
      status: 'FAILED',
    });
    recordPaymentOutcome({
      provider: 'MERCADOPAGO',
      type: 'ORDER',
      status: 'FAILED',
    });
    const metric = await register
      .getSingleMetric('ekoru_payments_total')
      ?.get();
    const failed = metric?.values.find(
      (v) =>
        v.labels.status === 'FAILED' && v.labels.provider === 'MERCADOPAGO',
    );
    expect(failed?.value).toBe(2);
  });

  it('reads the queue backlog when scraped, and reports nothing when Redis is away', async () => {
    const queue = {
      getJobCounts: jest
        .fn()
        .mockResolvedValueOnce({ waiting: 4, active: 1, delayed: 0, failed: 2 })
        .mockRejectedValueOnce(new Error('ECONNREFUSED')),
    };
    registerPaymentQueueGauge(queue as unknown as Queue);
    const gauge = register.getSingleMetric('ekoru_payments_queue_depth');

    const first = await gauge?.get();
    expect(first?.values.find((v) => v.labels.state === 'waiting')?.value).toBe(
      4,
    );

    const second = await gauge?.get();
    expect(second?.values).toHaveLength(0);
  });
});
