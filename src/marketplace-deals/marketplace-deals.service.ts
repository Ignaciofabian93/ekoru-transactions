import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotFoundError, BadRequestError } from '../common/exceptions/index.js';
import { MarketplaceClient, UsersClient } from '../common/clients/index.js';
import { P2PStatus, P2PDealType, TransactionKind } from '@prisma/client';

/** Deals still holding an item / awaiting completion. */
const OPEN_STATUSES: P2PStatus[] = [P2PStatus.PROPOSED, P2PStatus.ACCEPTED];

@Injectable()
export class MarketplaceDealsService {
  private readonly logger = new Logger(MarketplaceDealsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketplace: MarketplaceClient,
    private readonly users: UsersClient,
    private readonly config: ConfigService,
  ) {}

  private cfg<T>(key: string): T {
    return this.config.get<T>(`p2p.${key}`) as T;
  }

  // ─── Proposals ──────────────────────────────────────────────────────────────

  async proposeSale({
    productId,
    buyerId,
  }: {
    productId: number;
    buyerId: string;
  }) {
    if (!buyerId) throw new BadRequestError('Debe iniciar sesión');
    await this._assertNotBlocked(buyerId);

    const [product] = await this.marketplace.getPrices([productId]);
    if (!product.isActive || this.marketplace.isSold(product)) {
      throw new BadRequestError('Producto no disponible');
    }
    if (this.marketplace.isReserved(product)) {
      throw new BadRequestError(
        'Este producto ya está reservado por otro trato',
      );
    }
    if (product.sellerId === buyerId) {
      throw new BadRequestError('No puedes comprar tu propio producto');
    }
    await this._assertNoOpenDeal([productId]);

    return this.prisma.p2PDeal.create({
      data: {
        type: P2PDealType.SALE,
        status: P2PStatus.PROPOSED,
        buyerId,
        sellerId: product.sellerId,
        productId,
      },
    });
  }

  async proposeExchange({
    requestedProductId,
    offeredProductId,
    buyerId,
  }: {
    requestedProductId: number;
    offeredProductId: number;
    buyerId: string;
  }) {
    if (!buyerId) throw new BadRequestError('Debe iniciar sesión');
    if (requestedProductId === offeredProductId) {
      throw new BadRequestError(
        'Los productos del intercambio deben ser distintos',
      );
    }
    await this._assertNotBlocked(buyerId);

    const products = await this.marketplace.getPrices([
      requestedProductId,
      offeredProductId,
    ]);
    const requested = products.find((p) => p.id === requestedProductId)!;
    const offered = products.find((p) => p.id === offeredProductId)!;

    if (!requested.isExchangeable) {
      throw new BadRequestError(
        'El producto solicitado no acepta intercambios',
      );
    }
    if (
      !requested.isActive ||
      !offered.isActive ||
      this.marketplace.isSold(requested) ||
      this.marketplace.isSold(offered)
    ) {
      throw new BadRequestError('Alguno de los productos no está disponible');
    }
    if (
      this.marketplace.isReserved(requested) ||
      this.marketplace.isReserved(offered)
    ) {
      throw new BadRequestError('Alguno de los productos ya está reservado');
    }
    if (offered.sellerId !== buyerId) {
      throw new BadRequestError('El producto ofrecido debe ser tuyo');
    }
    if (requested.sellerId === buyerId) {
      throw new BadRequestError('No puedes intercambiar contigo mismo');
    }
    await this._assertNoOpenDeal([requestedProductId, offeredProductId]);

    // Cash compensation when the price gap is substantial: the owner of the
    // cheaper item tops up the difference.
    const diff = Math.abs(requested.price - offered.price);
    const threshold = this.cfg<number>('compensationThresholdClp');
    const compensationAmount = diff >= threshold ? diff : 0;
    const compensationPayerId =
      compensationAmount === 0
        ? null
        : offered.price < requested.price
          ? buyerId // buyer's item is cheaper → buyer tops up
          : requested.sellerId;

    return this.prisma.p2PDeal.create({
      data: {
        type: P2PDealType.EXCHANGE,
        status: P2PStatus.PROPOSED,
        buyerId,
        sellerId: requested.sellerId,
        requestedProductId,
        offeredProductId,
        compensationAmount,
        compensationPayerId,
      },
    });
  }

  // ─── Seller responses ─────────────────────────────────────────────────────

  async acceptDeal({ id, sellerId }: { id: number; sellerId: string }) {
    const deal = await this._load(id);
    if (deal.sellerId !== sellerId) {
      throw new BadRequestError('Solo el dueño del producto puede aceptar');
    }
    if (deal.status !== P2PStatus.PROPOSED) {
      throw new BadRequestError('Este trato ya no está pendiente');
    }
    await this._assertNotBlocked(sellerId);

    const deadline = new Date(
      Date.now() + this.cfg<number>('confirmWindowHours') * 3600_000,
    );
    const updated = await this.prisma.p2PDeal.update({
      where: { id },
      data: {
        status: P2PStatus.ACCEPTED,
        agreedAt: new Date(),
        confirmationDeadline: deadline,
      },
    });
    await this.marketplace.reserveProducts(this._itemIds(deal), deadline);
    return updated;
  }

  async declineDeal({
    id,
    sellerId,
    reason,
  }: {
    id: number;
    sellerId: string;
    reason?: string;
  }) {
    const deal = await this._load(id);
    if (deal.sellerId !== sellerId) {
      throw new BadRequestError('Solo el dueño del producto puede rechazar');
    }
    if (deal.status !== P2PStatus.PROPOSED) {
      throw new BadRequestError('Este trato ya no está pendiente');
    }
    return this.prisma.p2PDeal.update({
      where: { id },
      data: { status: P2PStatus.DECLINED, cancelReason: reason },
    });
  }

  // ─── Confirmation / completion ────────────────────────────────────────────

  async confirmDeal({
    id,
    callerId,
    evidenceUrl,
  }: {
    id: number;
    callerId: string;
    evidenceUrl?: string;
  }) {
    const deal = await this._load(id);
    if (deal.status !== P2PStatus.ACCEPTED) {
      throw new BadRequestError('Este trato no está en curso');
    }
    const isBuyer = deal.buyerId === callerId;
    const isSeller = deal.sellerId === callerId;
    if (!isBuyer && !isSeller) {
      throw new BadRequestError('No participas en este trato');
    }

    // Whoever receives an item must upload a photo of it. The buyer always
    // receives one; the seller only does in an exchange.
    const mustProvidePhoto = isBuyer || deal.type === P2PDealType.EXCHANGE;
    if (mustProvidePhoto && !evidenceUrl) {
      throw new BadRequestError('Debes subir una foto del producto recibido');
    }

    const updated = await this.prisma.p2PDeal.update({
      where: { id },
      data: isBuyer
        ? { buyerConfirmedAt: new Date(), buyerEvidenceUrl: evidenceUrl }
        : { sellerConfirmedAt: new Date(), sellerEvidenceUrl: evidenceUrl },
    });

    if (updated.buyerConfirmedAt && updated.sellerConfirmedAt) {
      return this._completeDeal(updated);
    }
    return updated;
  }

  private async _completeDeal(deal: { id: number } & DealCore) {
    const completed = await this.prisma.p2PDeal.update({
      where: { id: deal.id },
      data: { status: P2PStatus.COMPLETED, completedAt: new Date() },
    });

    await this.marketplace.markProductsSold(this._itemIds(deal), deal.type);
    await this._awardPoints(deal);
    await Promise.all([
      this._bumpReputation(deal.buyerId, { completed: true }),
      this._bumpReputation(deal.sellerId, { completed: true }),
    ]);
    return completed;
  }

  // ─── Dispute / cancel / admin ─────────────────────────────────────────────

  async disputeDeal({
    id,
    callerId,
    reason,
  }: {
    id: number;
    callerId: string;
    reason: string;
  }) {
    const deal = await this._load(id);
    if (deal.buyerId !== callerId && deal.sellerId !== callerId) {
      throw new BadRequestError('No participas en este trato');
    }
    if (deal.status !== P2PStatus.ACCEPTED) {
      throw new BadRequestError('Solo un trato en curso puede disputarse');
    }
    return this.prisma.p2PDeal.update({
      where: { id },
      data: {
        status: P2PStatus.DISPUTED,
        disputedAt: new Date(),
        disputeReason: reason,
      },
    });
  }

  async cancelDeal({ id, callerId }: { id: number; callerId: string }) {
    const deal = await this._load(id);
    if (deal.buyerId !== callerId && deal.sellerId !== callerId) {
      throw new BadRequestError('No participas en este trato');
    }
    if (!OPEN_STATUSES.includes(deal.status)) {
      throw new BadRequestError('Este trato ya no puede cancelarse');
    }
    const updated = await this.prisma.p2PDeal.update({
      where: { id },
      data: { status: P2PStatus.CANCELLED },
    });
    if (deal.status === P2PStatus.ACCEPTED) {
      await this.marketplace.releaseProducts(this._itemIds(deal));
    }
    return updated;
  }

  /** Admin-only: resolve a disputed deal. */
  async resolveDeal({
    id,
    outcome,
    strikeSellerId,
  }: {
    id: number;
    outcome: 'COMPLETED' | 'CANCELLED';
    strikeSellerId?: string;
  }) {
    const deal = await this._load(id);
    if (deal.status !== P2PStatus.DISPUTED) {
      throw new BadRequestError('Solo se resuelven tratos en disputa');
    }
    if (strikeSellerId) await this._strike(strikeSellerId);

    if (outcome === 'COMPLETED') return this._completeDeal(deal);

    const updated = await this.prisma.p2PDeal.update({
      where: { id },
      data: { status: P2PStatus.CANCELLED },
    });
    await this.marketplace.releaseProducts(this._itemIds(deal));
    return updated;
  }

  // ─── Deadline sweep (called by the BullMQ worker) ──────────────────────────

  async sweepExpiredDeals(): Promise<number> {
    const overdue = await this.prisma.p2PDeal.findMany({
      where: {
        status: P2PStatus.ACCEPTED,
        confirmationDeadline: { lt: new Date() },
      },
    });

    for (const deal of overdue) {
      // Strike whoever failed to confirm in time.
      const offenders: string[] = [];
      if (!deal.buyerConfirmedAt) offenders.push(deal.buyerId);
      if (!deal.sellerConfirmedAt) offenders.push(deal.sellerId);

      await this.prisma.p2PDeal.update({
        where: { id: deal.id },
        data: { status: P2PStatus.EXPIRED },
      });
      await this.marketplace.releaseProducts(this._itemIds(deal));
      for (const sellerId of offenders) await this._strike(sellerId);
    }

    if (overdue.length) {
      this.logger.log(`P2P sweep: expired ${overdue.length} overdue deal(s)`);
    }

    // Same cadence: clean up products sold long enough ago (soft-delete).
    await this.marketplace.purgeSoldProducts(
      this.cfg<number>('soldRetentionDays'),
    );
    return overdue.length;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getDeal(id: number) {
    return this.prisma.p2PDeal.findUnique({ where: { id } });
  }

  myDealsAsBuyer(buyerId: string) {
    return this.prisma.p2PDeal.findMany({
      where: { buyerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  myDealsAsSeller(sellerId: string) {
    return this.prisma.p2PDeal.findMany({
      where: { sellerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async myReputation(sellerId: string) {
    return this._reputation(sellerId);
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private async _load(id: number) {
    const deal = await this.prisma.p2PDeal.findUnique({ where: { id } });
    if (!deal) throw new NotFoundError('Trato no encontrado');
    return deal;
  }

  /** SALE → [productId]; EXCHANGE → [requested, offered]. */
  private _itemIds(deal: DealCore): number[] {
    if (deal.type === P2PDealType.SALE) {
      return deal.productId != null ? [deal.productId] : [];
    }
    return [deal.requestedProductId, deal.offeredProductId].filter(
      (x): x is number => x != null,
    );
  }

  private async _assertNoOpenDeal(productIds: number[]): Promise<void> {
    const existing = await this.prisma.p2PDeal.findFirst({
      where: {
        status: { in: OPEN_STATUSES },
        OR: [
          { productId: { in: productIds } },
          { requestedProductId: { in: productIds } },
          { offeredProductId: { in: productIds } },
        ],
      },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestError(
        'Ya existe un trato abierto para este producto',
      );
    }
  }

  private async _reputation(sellerId: string) {
    return this.prisma.p2PReputation.upsert({
      where: { sellerId },
      create: { sellerId },
      update: {},
    });
  }

  private async _assertNotBlocked(sellerId: string): Promise<void> {
    const rep = await this.prisma.p2PReputation.findUnique({
      where: { sellerId },
      select: { blockedUntil: true },
    });
    if (rep?.blockedUntil && rep.blockedUntil.getTime() > Date.now()) {
      throw new BadRequestError(
        'Tu cuenta está temporalmente bloqueada para tratos por incumplimientos previos',
      );
    }
  }

  private async _strike(sellerId: string): Promise<void> {
    const rep = await this._reputation(sellerId);
    const threshold = this.cfg<number>('strikeBlockThreshold');
    const nextStrikes = rep.strikes + 1;
    const shouldBlock = nextStrikes >= threshold;
    await this.prisma.p2PReputation.update({
      where: { sellerId },
      data: {
        strikes: shouldBlock ? 0 : nextStrikes,
        failedCount: { increment: 1 },
        blockedUntil: shouldBlock
          ? new Date(Date.now() + this.cfg<number>('blockDays') * 86_400_000)
          : rep.blockedUntil,
      },
    });
  }

  private async _bumpReputation(
    sellerId: string,
    { completed }: { completed: boolean },
  ): Promise<void> {
    await this.prisma.p2PReputation.upsert({
      where: { sellerId },
      create: {
        sellerId,
        completedCount: completed ? 1 : 0,
      },
      update: completed ? { completedCount: { increment: 1 } } : {},
    });
  }

  /** Writes the eco-transaction ledger + credits points to both parties. */
  private async _awardPoints(deal: DealCore): Promise<void> {
    const points = this.cfg<number>('completionPoints');
    const isExchange = deal.type === P2PDealType.EXCHANGE;
    const buyerKind = isExchange
      ? TransactionKind.EXCHANGE
      : TransactionKind.PURCHASE;
    const sellerKind = isExchange
      ? TransactionKind.EXCHANGE
      : TransactionKind.SELL;

    try {
      await this.prisma.transaction.createMany({
        data: [
          { kind: buyerKind, pointsCollected: points, sellerId: deal.buyerId },
          {
            kind: sellerKind,
            pointsCollected: points,
            sellerId: deal.sellerId,
          },
        ],
      });
      await Promise.all([
        this.users.awardPoints(deal.buyerId, points),
        this.users.awardPoints(deal.sellerId, points),
      ]);
    } catch (err) {
      // Points are a reward, not the record of truth — never fail a completed
      // deal because the ledger/credit hiccupped.
      this.logger.error(`Awarding points failed for deal ${deal.id}`, err);
    }
  }
}

/** The deal fields the helpers above read (subset of the Prisma row). */
interface DealCore {
  id: number;
  type: P2PDealType;
  status: P2PStatus;
  buyerId: string;
  sellerId: string;
  productId: number | null;
  requestedProductId: number | null;
  offeredProductId: number | null;
  buyerConfirmedAt: Date | null;
  sellerConfirmedAt: Date | null;
}
