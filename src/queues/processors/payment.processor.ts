import {
  Processor,
  WorkerHost,
  OnWorkerEvent,
  InjectQueue,
} from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { PAYMENT_JOBS, PAYMENT_QUEUE } from '../../payments/payment-queue.js';
import { SettlementService } from '../../payments/settlement.service.js';

interface RefundJob {
  refundId: number;
}

interface StockJob {
  kind: 'SALE' | 'RESTOCK';
  orderId: number;
  paymentId: number;
}

interface QuotationJob {
  paymentId: number;
}

/**
 * PaymentProcessor
 * ────────────────
 * Consumes the `payments` queue. Every job here calls the provider or another
 * service, so it runs with retries, and the work behind it
 * (SettlementService) is keyed so a retry never repeats a movement.
 *
 *   process-refund    the provider gives the money back (TRX-2)
 *   adjust-stock      stores takes sold units out, or puts them back (TRX-3)
 *   settle-quotation  services stamps a paid quotation (TRX-6)
 *   expire-stale      abandoned checkouts expire (TRX-9), on a schedule
 *
 * The provider charge itself is synchronous (PaymentsService.createPayment):
 * the redirect is what the buyer is waiting for. The old `initiate-payment`
 * and `process-webhook` handlers simulated providers with fake ids and nothing
 * enqueued them, so they are gone (TRX-14).
 */
@Processor(PAYMENT_QUEUE)
export class PaymentProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(PaymentProcessor.name);

  constructor(
    private readonly settlement: SettlementService,
    private readonly config: ConfigService,
    @InjectQueue(PAYMENT_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    const everyMin = this.config.get<number>(
      'payments.expireSweepEveryMin',
      10,
    );
    await this.queue.add(
      PAYMENT_JOBS.expire,
      {},
      {
        repeat: { every: everyMin * 60_000 },
        jobId: 'payments-expire-sweep', // stable id → one schedule, survives redeploys
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    this.logger.log(`Stale checkout sweep scheduled every ${everyMin} min`);
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case PAYMENT_JOBS.refund:
        return this.refund(job as Job<RefundJob>);
      case PAYMENT_JOBS.stock: {
        const data = (job as Job<StockJob>).data;
        return data.kind === 'SALE'
          ? this.settlement.takeStock(data)
          : this.settlement.restock(data);
      }
      case PAYMENT_JOBS.quotation:
        return this.settlement.settleQuotation(
          (job as Job<QuotationJob>).data.paymentId,
        );
      case PAYMENT_JOBS.expire:
        return this.settlement.expireStale(
          this.config.get<number>('payments.expireAfterMinutes', 60),
        );
      default:
        this.logger.warn(
          `Trabajo desconocido en la cola de pagos: ${job.name}`,
        );
        return null;
    }
  }

  /** On the last failed attempt the refund is marked FAILED, never left hanging. */
  private async refund(job: Job<RefundJob>) {
    try {
      return await this.settlement.executeRefund(job.data.refundId);
    } catch (error) {
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade + 1 >= attempts) {
        await this.settlement.failRefund(
          job.data.refundId,
          error instanceof Error ? error.message : 'Error desconocido',
        );
      }
      throw error;
    }
  }

  // ─── Worker events ──────────────────────────────────────────────────────────

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(`✓ Trabajo completado [${job.name}] id=${job.id}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(
      `✗ Trabajo fallido [${job.name}] id=${job.id} intentos=${job.attemptsMade}: ${error.message}`,
    );
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.debug(`→ Procesando [${job.name}] id=${job.id}`);
  }
}
