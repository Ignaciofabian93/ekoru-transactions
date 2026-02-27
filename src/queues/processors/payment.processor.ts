import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PAYMENT_QUEUE } from '../../payments/payments.service.js';

// ─── Job payload types ────────────────────────────────────────────────────────

interface InitiatePaymentJob {
  paymentId: number;
  provider: 'KHIPU' | 'WEBPAY';
  amount: number;
  currency: string;
  description?: string;
  payerId: string;
  receiverId: string;
  configId: number;
}

interface ProcessRefundJob {
  refundId: number;
  paymentId: number;
  amount: number;
  provider: 'KHIPU' | 'WEBPAY';
}

interface ProcessWebhookJob {
  webhookId: number;
}

// ─── Processor ────────────────────────────────────────────────────────────────

/**
 * PaymentProcessor
 * ────────────────
 * Handles all jobs in the `payments` queue. Each method handles a specific
 * job name using pattern-matched `process()` from BullMQ's WorkerHost.
 *
 * HOW QUEUES WORK IN THIS PROJECT
 * ────────────────────────────────
 * 1. Producer  → a Service calls `queue.add('job-name', data, options)`
 * 2. Queue     → Redis stores the job and its payload
 * 3. Worker    → this Processor picks up the job from Redis and runs `process()`
 * 4. Retries   → if `process()` throws, BullMQ retries up to `attempts` times
 *                with the configured backoff strategy
 * 5. Events    → `@OnWorkerEvent` hooks let us log completed/failed jobs
 *
 * KHIPU FLOW (Chilean bank transfers):
 *   1. POST to https://khipu.com/api/2.0/payments with receiver_id + amount
 *   2. Khipu returns { payment_id, payment_url }
 *   3. We store payment_url → client redirects there to confirm
 *   4. Khipu POSTs webhook to our URL when the transfer is confirmed
 *   5. process-webhook job updates Payment.status to COMPLETED
 *
 * WEBPAY FLOW (credit/debit cards via Transbank):
 *   1. POST to Webpay Plus API with buyOrder + amount + returnUrl
 *   2. Webpay returns { token, url } → client redirects to url?token=...
 *   3. After card entry, Webpay redirects to returnUrl?token_ws=...
 *   4. We confirm with Webpay (GET /transactions/{token})
 *   5. process-webhook job updates Payment.status accordingly
 */
@Processor(PAYMENT_QUEUE)
export class PaymentProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * Entry point – BullMQ calls this for every job in the queue.
   * We dispatch to the appropriate handler based on job.name.
   */
  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case 'initiate-payment':
        return this.initiatePayment(job as Job<InitiatePaymentJob>);
      case 'process-refund':
        return this.processRefund(job as Job<ProcessRefundJob>);
      case 'process-webhook':
        return this.processWebhook(job as Job<ProcessWebhookJob>);
      default:
        this.logger.warn(`Trabajo desconocido en la cola de pagos: ${job.name}`);
        return null;
    }
  }

  // ─── Job handlers ───────────────────────────────────────────────────────────

  /**
   * Calls the Chilean payment provider (Khipu or Webpay) to initiate the
   * payment and stores the external ID + token returned by the provider.
   *
   * In a real implementation this would use the provider's SDK/API.
   * The structure below shows exactly where those calls belong.
   */
  private async initiatePayment(job: Job<InitiatePaymentJob>) {
    const { paymentId, provider, amount, currency, description } = job.data;

    this.logger.log(
      `[${provider}] Iniciando pago ${paymentId} – ${amount} ${currency}`,
    );

    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'PROCESSING', updatedAt: new Date() },
    });

    try {
      let externalId: string;
      let externalToken: string;

      if (provider === 'KHIPU') {
        // ── Khipu ──────────────────────────────────────────────────────────
        // Real call would be:
        //   const khipu = new KhipuClient({ receiverId, apiKey });
        //   const { payment_id, payment_url } = await khipu.createPayment({
        //     subject: description,
        //     currency: 'CLP',
        //     amount,
        //   });
        externalId = `khipu_sim_${paymentId}`;
        externalToken = `khipu_url_sim_${paymentId}`;
      } else {
        // ── Webpay ─────────────────────────────────────────────────────────
        // Real call would be:
        //   const tx = new WebpayPlus.Transaction(new Options(IntegrationCommerceCodes.WEBPAY_PLUS, ...));
        //   const { token, url } = await tx.create(buyOrder, sessionId, amount, returnUrl);
        externalId = `webpay_sim_${paymentId}`;
        externalToken = `webpay_token_sim_${paymentId}`;
      }

      await this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          externalId,
          externalToken,
          updatedAt: new Date(),
        },
      });

      // Log the provider interaction
      await this.prisma.paymentTransaction.create({
        data: {
          paymentId,
          action: 'INITIATE',
          amount,
          status: 'PROCESSING',
          description: `Pago iniciado con ${provider}`,
        },
      });

      return { externalId, externalToken };
    } catch (error) {
      await this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: 'FAILED',
          failureReason:
            error instanceof Error ? error.message : 'Error desconocido',
          updatedAt: new Date(),
        },
      });
      throw error; // Re-throw so BullMQ retries the job
    }
  }

  /**
   * Calls the provider to process a refund.
   */
  private async processRefund(job: Job<ProcessRefundJob>) {
    const { refundId, paymentId, amount, provider } = job.data;

    this.logger.log(
      `[${provider}] Procesando reembolso ${refundId} – ${amount} CLP`,
    );

    try {
      // Real call: provider.refund(externalId, amount)
      const externalRefundId = `refund_sim_${refundId}`;

      await this.prisma.paymentRefund.update({
        where: { id: refundId },
        data: {
          status: 'COMPLETED',
          externalId: externalRefundId,
          processedAt: new Date(),
        },
      });

      await this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: 'REFUNDED',
          refundedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      await this.prisma.paymentTransaction.create({
        data: {
          paymentId,
          action: 'REFUND',
          amount,
          status: 'COMPLETED',
          description: `Reembolso procesado con ${provider}`,
        },
      });

      return { externalRefundId };
    } catch (error) {
      await this.prisma.paymentRefund.update({
        where: { id: refundId },
        data: { status: 'FAILED' },
      });
      throw error;
    }
  }

  /**
   * Reconciles a webhook event from Khipu or Webpay.
   * Maps provider event types to our internal PaymentStatus.
   */
  private async processWebhook(job: Job<ProcessWebhookJob>) {
    const { webhookId } = job.data;

    this.logger.log(`Procesando webhook ${webhookId}`);

    const webhook = await this.prisma.paymentWebhook.findUnique({
      where: { id: webhookId },
      select: {
        id: true,
        paymentId: true,
        provider: true,
        eventType: true,
        payload: true,
        processed: true,
      },
    });

    if (!webhook || webhook.processed) return null;

    try {
      // Map provider event → internal status
      let newStatus: string | null = null;

      if (webhook.provider === 'KHIPU') {
        // Khipu events: payment_received, payment_rejected, payment_expired
        if (webhook.eventType === 'payment_received') newStatus = 'COMPLETED';
        else if (webhook.eventType === 'payment_rejected') newStatus = 'FAILED';
        else if (webhook.eventType === 'payment_expired') newStatus = 'EXPIRED';
      } else {
        // Webpay events: authorized, failed, reversed
        if (webhook.eventType === 'authorized') newStatus = 'COMPLETED';
        else if (webhook.eventType === 'failed') newStatus = 'FAILED';
        else if (webhook.eventType === 'reversed') newStatus = 'REFUNDED';
      }

      if (newStatus && webhook.paymentId) {
        await this.prisma.payment.update({
          where: { id: webhook.paymentId },
          data: {
            status: newStatus as any,
            ...(newStatus === 'COMPLETED' && { processedAt: new Date() }),
            updatedAt: new Date(),
          },
        });

        await this.prisma.paymentTransaction.create({
          data: {
            paymentId: webhook.paymentId,
            action: 'WEBHOOK',
            status: newStatus,
            description: `Webhook: ${webhook.eventType} desde ${webhook.provider}`,
            metadata: webhook.payload as any,
          },
        });
      }

      await this.prisma.paymentWebhook.update({
        where: { id: webhookId },
        data: { processed: true, processedAt: new Date() },
      });

      return { status: newStatus };
    } catch (error) {
      await this.prisma.paymentWebhook.update({
        where: { id: webhookId },
        data: {
          processingError:
            error instanceof Error ? error.message : 'Error desconocido',
        },
      });
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
