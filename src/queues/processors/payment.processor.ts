import {
  Processor,
  WorkerHost,
  OnWorkerEvent,
  InjectQueue,
} from '@nestjs/bullmq';
import {
  BeforeApplicationShutdown,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { PAYMENT_JOBS, PAYMENT_QUEUE } from '../../payments/payment-queue.js';
import { SettlementService } from '../../payments/settlement.service.js';
import { PaymentsService } from '../../payments/payments.service.js';
import { MercadoPagoConnectService } from '../../payments/mercadopago/mercadopago-connect.service.js';
import { PaymentSecrets } from '../../payments/payment-secrets.js';
import { registerPaymentQueueGauge } from '../../payments/payments.metrics.js';

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
 *   expire-stale      abandoned checkouts expire (TRX-9), on a schedule;
 *                     Mercado Pago is asked first, so a paid one settles
 *   refresh-mercadopago-tokens  stores' Mercado Pago tokens renewed (daily)
 *
 * The provider charge itself is synchronous (PaymentsService.createPayment):
 * the redirect is what the buyer is waiting for. The old `initiate-payment`
 * and `process-webhook` handlers simulated providers with fake ids and nothing
 * enqueued them, so they are gone (TRX-14).
 */
@Processor(PAYMENT_QUEUE)
export class PaymentProcessor
  extends WorkerHost
  implements OnModuleInit, BeforeApplicationShutdown
{
  private readonly logger = new Logger(PaymentProcessor.name);

  constructor(
    private readonly settlement: SettlementService,
    private readonly config: ConfigService,
    @InjectQueue(PAYMENT_QUEUE) private readonly queue: Queue,
    private readonly payments: PaymentsService,
    private readonly mercadoPagoConnect: MercadoPagoConnectService,
    private readonly secrets: PaymentSecrets,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    // Queue backlog for the alerts, read at scrape time (INF-5).
    registerPaymentQueueGauge(this.queue);
    // Credentials stored before PAYMENT_SECRETS_KEY existed get sealed (TRX-21).
    await this.secrets
      .sealExistingRows()
      .catch((error: unknown) =>
        this.logger.error('Could not seal stored payment secrets', error),
      );

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

    await this.queue.add(
      PAYMENT_JOBS.mercadoPagoTokens,
      {},
      {
        repeat: { every: 24 * 60 * 60_000 },
        jobId: 'mercadopago-token-refresh',
        removeOnComplete: true,
        removeOnFail: 20,
      },
    );
  }

  /**
   * On shutdown, waits for the job in progress before anything else closes:
   * Prisma and Redis close later, in onApplicationShutdown.
   */
  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.close();
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
      case PAYMENT_JOBS.expire: {
        const window = this.config.get<number>(
          'payments.expireAfterMinutes',
          60,
        );
        await this.payments.reconcileStale(window);
        return this.settlement.expireStale(window);
      }
      case PAYMENT_JOBS.mercadoPagoTokens:
        return this.mercadoPagoConnect.refreshExpiring();
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
