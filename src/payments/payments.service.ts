import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  NotFoundError,
  BadRequestError,
  InternalServerError,
} from '../common/exceptions/index.js';
import {
  calculatePrismaParams,
  createPaginatedResponse,
} from '../common/utils/index.js';
import {
  CreatePaymentInput,
  CreatePaymentConfigInput,
  RefundPaymentInput,
} from './dto/index.js';
import {
  ChileanPaymentProvider,
  PaymentStatus,
} from '../graphql/enums/index.js';

// Queue name constants – used by both service and processor
export const PAYMENT_QUEUE = 'payments';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(PAYMENT_QUEUE) private readonly paymentQueue: Queue,
  ) {}

  // ─── Payment Config ───────────────────────────────────────────────────────

  async getPaymentConfig(id: number) {
    try {
      const config = await this.prisma.chileanPaymentConfig.findUnique({
        where: { id },
        select: {
          id: true,
          sellerId: true,
          provider: true,
          merchantId: true,
          environment: true,
          isActive: true,
          webhookUrl: true,
          returnUrl: true,
          cancelUrl: true,
          createdAt: true,
          updatedAt: true,
          // apiKey and secretKey intentionally excluded – write-only
        },
      });

      if (!config) {
        throw new NotFoundError('Configuración de pago no encontrada');
      }

      return config;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      this.logger.error('Error al obtener la configuración de pago:', error);
      throw new InternalServerError(
        'Error al obtener la configuración de pago',
      );
    }
  }

  async getPaymentConfigsBySeller(sellerId: string) {
    try {
      return await this.prisma.chileanPaymentConfig.findMany({
        where: { sellerId },
        select: {
          id: true,
          sellerId: true,
          provider: true,
          merchantId: true,
          environment: true,
          isActive: true,
          webhookUrl: true,
          returnUrl: true,
          cancelUrl: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    } catch (error) {
      this.logger.error(
        'Error al obtener configuraciones de pago del vendedor:',
        error,
      );
      throw new InternalServerError(
        'Error al obtener configuraciones de pago del vendedor',
      );
    }
  }

  async createPaymentConfig(input: CreatePaymentConfigInput) {
    try {
      // Each seller can have at most one config per provider
      const existing = await this.prisma.chileanPaymentConfig.findUnique({
        where: {
          sellerId_provider: {
            sellerId: input.sellerId,
            provider: input.provider as ChileanPaymentProvider,
          },
        },
      });

      if (existing) {
        throw new BadRequestError(
          `Ya existe una configuración para el proveedor ${input.provider}`,
        );
      }

      return await this.prisma.chileanPaymentConfig.create({
        data: {
          sellerId: input.sellerId,
          provider: input.provider,
          merchantId: input.merchantId,
          apiKey: input.apiKey,
          secretKey: input.secretKey,
          environment: input.environment,
          isActive: input.isActive ?? true,
          webhookUrl: input.webhookUrl,
          returnUrl: input.returnUrl,
          cancelUrl: input.cancelUrl,
          updatedAt: new Date(),
        },
        select: {
          id: true,
          sellerId: true,
          provider: true,
          merchantId: true,
          environment: true,
          isActive: true,
          webhookUrl: true,
          returnUrl: true,
          cancelUrl: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    } catch (error) {
      if (error instanceof BadRequestError) throw error;
      this.logger.error('Error al crear la configuración de pago:', error);
      throw new InternalServerError(
        'Error al crear la configuración de pago',
      );
    }
  }

  // ─── Payments ─────────────────────────────────────────────────────────────

  async getPayment(id: number) {
    try {
      const payment = await this.prisma.payment.findUnique({
        where: { id },
        select: {
          id: true,
          orderId: true,
          quotationId: true,
          amount: true,
          currency: true,
          status: true,
          paymentProvider: true,
          externalId: true,
          externalToken: true,
          description: true,
          fees: true,
          netAmount: true,
          payerId: true,
          receiverId: true,
          failureReason: true,
          metadata: true,
          paymentType: true,
          chileanConfigId: true,
          createdAt: true,
          updatedAt: true,
          processedAt: true,
          refundedAt: true,
        },
      });

      if (!payment) {
        throw new NotFoundError('Pago no encontrado');
      }

      return {
        ...payment,
        payer: { id: payment.payerId },
        receiver: { id: payment.receiverId },
      };
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      this.logger.error('Error al obtener el pago:', error);
      throw new InternalServerError('Error al obtener el pago');
    }
  }

  async getPaymentsByPayer(
    payerId: string,
    page: number,
    pageSize: number,
    status?: PaymentStatus,
  ) {
    try {
      const { skip, take } = calculatePrismaParams(page, pageSize);
      const where = { payerId, ...(status && { status }) };

      const count = await this.prisma.payment.count({ where });
      const payments = await this.prisma.payment.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderId: true,
          quotationId: true,
          amount: true,
          currency: true,
          status: true,
          paymentProvider: true,
          externalId: true,
          description: true,
          fees: true,
          netAmount: true,
          payerId: true,
          receiverId: true,
          paymentType: true,
          chileanConfigId: true,
          createdAt: true,
          updatedAt: true,
          processedAt: true,
        },
      });

      const mapped = payments.map((p) => ({
        ...p,
        payer: { id: p.payerId },
        receiver: { id: p.receiverId },
      }));

      return createPaginatedResponse(mapped, count, page, pageSize);
    } catch (error) {
      this.logger.error('Error al obtener pagos del pagador:', error);
      throw new InternalServerError('Error al obtener pagos del pagador');
    }
  }

  async getPaymentsByReceiver(
    receiverId: string,
    page: number,
    pageSize: number,
    status?: PaymentStatus,
  ) {
    try {
      const { skip, take } = calculatePrismaParams(page, pageSize);
      const where = { receiverId, ...(status && { status }) };

      const count = await this.prisma.payment.count({ where });
      const payments = await this.prisma.payment.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderId: true,
          quotationId: true,
          amount: true,
          currency: true,
          status: true,
          paymentProvider: true,
          externalId: true,
          description: true,
          fees: true,
          netAmount: true,
          payerId: true,
          receiverId: true,
          paymentType: true,
          chileanConfigId: true,
          createdAt: true,
          updatedAt: true,
          processedAt: true,
        },
      });

      const mapped = payments.map((p) => ({
        ...p,
        payer: { id: p.payerId },
        receiver: { id: p.receiverId },
      }));

      return createPaginatedResponse(mapped, count, page, pageSize);
    } catch (error) {
      this.logger.error('Error al obtener pagos del receptor:', error);
      throw new InternalServerError('Error al obtener pagos del receptor');
    }
  }

  /**
   * Creates a payment record and enqueues the actual payment initiation job.
   *
   * Flow:
   *   1. Validate the payment config belongs to the receiver.
   *   2. Create Payment row in DB with status PENDING.
   *   3. Enqueue a 'initiate-payment' job → processor calls provider API
   *      (Khipu / Webpay) asynchronously.
   *   4. Return the pending Payment immediately so the client can poll.
   */
  async createPayment(input: CreatePaymentInput) {
    try {
      const config = await this.prisma.chileanPaymentConfig.findFirst({
        where: {
          id: input.chileanConfigId,
          sellerId: input.receiverId,
          isActive: true,
        },
      });

      if (!config) {
        throw new BadRequestError(
          'Configuración de pago inválida o inactiva para este vendedor',
        );
      }

      const payment = await this.prisma.payment.create({
        data: {
          orderId: input.orderId,
          quotationId: input.quotationId,
          amount: input.amount,
          currency: input.currency ?? 'CLP',
          paymentProvider: input.paymentProvider,
          description: input.description,
          payerId: input.payerId,
          receiverId: input.receiverId,
          paymentType: input.paymentType,
          chileanConfigId: input.chileanConfigId,
          updatedAt: new Date(),
        },
        select: {
          id: true,
          orderId: true,
          quotationId: true,
          amount: true,
          currency: true,
          status: true,
          paymentProvider: true,
          description: true,
          payerId: true,
          receiverId: true,
          paymentType: true,
          chileanConfigId: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // Enqueue async payment initiation (Khipu/Webpay API call)
      await this.paymentQueue.add(
        'initiate-payment',
        {
          paymentId: payment.id,
          provider: input.paymentProvider,
          amount: input.amount,
          currency: payment.currency,
          description: input.description,
          payerId: input.payerId,
          receiverId: input.receiverId,
          configId: input.chileanConfigId,
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        },
      );

      this.logger.log(
        `Pago ${payment.id} creado – trabajo encolado para ${input.paymentProvider}`,
      );

      return {
        ...payment,
        payer: { id: payment.payerId },
        receiver: { id: payment.receiverId },
      };
    } catch (error) {
      if (error instanceof BadRequestError) throw error;
      this.logger.error('Error al crear el pago:', error);
      throw new InternalServerError('Error al crear el pago');
    }
  }

  /**
   * Processes a payment refund.
   * Creates a refund record and enqueues the refund job.
   */
  async refundPayment(input: RefundPaymentInput) {
    try {
      const payment = await this.prisma.payment.findUnique({
        where: { id: input.paymentId },
        select: { id: true, amount: true, status: true, paymentProvider: true },
      });

      if (!payment) {
        throw new NotFoundError('Pago no encontrado');
      }

      if (payment.status !== 'COMPLETED') {
        throw new BadRequestError(
          'Solo se pueden reembolsar pagos completados',
        );
      }

      if (input.amount > payment.amount) {
        throw new BadRequestError(
          'El monto del reembolso no puede superar el monto del pago',
        );
      }

      const refund = await this.prisma.paymentRefund.create({
        data: {
          paymentId: input.paymentId,
          amount: input.amount,
          reason: input.reason,
        },
        select: {
          id: true,
          paymentId: true,
          amount: true,
          reason: true,
          status: true,
          createdAt: true,
        },
      });

      // Enqueue refund job
      await this.paymentQueue.add(
        'process-refund',
        {
          refundId: refund.id,
          paymentId: input.paymentId,
          amount: input.amount,
          provider: payment.paymentProvider,
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 3000 },
        },
      );

      this.logger.log(
        `Reembolso ${refund.id} creado – trabajo encolado`,
      );

      return refund;
    } catch (error) {
      if (
        error instanceof NotFoundError ||
        error instanceof BadRequestError
      ) {
        throw error;
      }
      this.logger.error('Error al procesar el reembolso:', error);
      throw new InternalServerError('Error al procesar el reembolso');
    }
  }

  /**
   * Handles incoming payment webhooks from Khipu/Webpay.
   * Stores the raw payload and enqueues reconciliation.
   */
  async handleWebhook(
    provider: ChileanPaymentProvider,
    eventType: string,
    externalId: string,
    payload: Record<string, unknown>,
  ) {
    try {
      // Find associated payment
      const payment = await this.prisma.payment.findFirst({
        where: { externalId },
        select: { id: true },
      });

      const webhook = await this.prisma.paymentWebhook.create({
        data: {
          paymentId: payment?.id,
          provider,
          eventType,
          externalId,
          payload: payload as Prisma.InputJsonValue,
        },
        select: {
          id: true,
          paymentId: true,
          provider: true,
          eventType: true,
          processed: true,
          createdAt: true,
        },
      });

      // Enqueue webhook processing
      await this.paymentQueue.add(
        'process-webhook',
        { webhookId: webhook.id },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          priority: 1, // webhooks get high priority
        },
      );

      return webhook;
    } catch (error) {
      this.logger.error('Error al procesar el webhook:', error);
      throw new InternalServerError('Error al procesar el webhook');
    }
  }
}
