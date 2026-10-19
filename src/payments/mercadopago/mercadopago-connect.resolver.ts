import {
  Args,
  ArgsType,
  Field,
  Mutation,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentAdmin, CurrentSeller } from '../../common/decorators/index.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  assertBusinessSeller,
  businessAdminSeller,
} from '../../common/admin-access.js';
import { UnauthorizedError } from '../../common/exceptions/index.js';
import { MercadoPagoConnectService } from './mercadopago-connect.service.js';
import type { ConnectSurface } from './mercadopago-oauth-state.js';
import { StorePaymentSetup } from './store-payment-setup.entity.js';

@ArgsType()
class CompleteMercadoPagoConnectionArgs {
  // Named `oauth*` so the admin activity log redacts them.
  @Field(() => String, { description: 'The `code` Mercado Pago sent back.' })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  oauthCode: string;

  @Field(() => String, { description: 'The `state` Mercado Pago sent back.' })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  oauthState: string;
}

/** Whose payout account a call is about, who is acting, and from where. */
interface PayoutCaller {
  sellerId: string;
  actor: string;
  surface: ConnectSurface;
}

/**
 * A business sets up where its sales are paid (TRX-5, WEB-2), for free:
 * - on the web or the app, signed in as the business itself;
 * - in the admin panel's business area, as one of its BUSINESS admins (the
 *   owner or a MANAGE_BUSINESS_PROFILE holder may change it, any of them may
 *   look).
 * Always for its own store only. Platform admins see every connection in the
 * panel's payment configs screen instead.
 */
@Resolver(() => StorePaymentSetup)
export class MercadoPagoConnectResolver {
  constructor(
    private readonly connect: MercadoPagoConnectService,
    private readonly prisma: PrismaService,
  ) {}

  @Query(() => StorePaymentSetup, {
    name: 'myStorePaymentSetup',
    description: "The signed-in business's Mercado Pago connection.",
  })
  async myStorePaymentSetup(
    @CurrentSeller() sellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    const caller = await this.caller({ sellerId, adminId, manage: false });
    return this.connect.status(caller.sellerId);
  }

  @Mutation(() => String, {
    name: 'startMercadoPagoConnection',
    description:
      'The Mercado Pago page to send the business to; it comes back where it started (panel or web) with a code.',
  })
  async startMercadoPagoConnection(
    @CurrentSeller() sellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    const caller = await this.caller({ sellerId, adminId, manage: true });
    return this.connect.authorizationUrl(caller);
  }

  @Mutation(() => StorePaymentSetup, { name: 'completeMercadoPagoConnection' })
  async completeMercadoPagoConnection(
    @Args() { oauthCode, oauthState }: CompleteMercadoPagoConnectionArgs,
    @CurrentSeller() sellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    const caller = await this.caller({ sellerId, adminId, manage: true });
    return this.connect.complete({
      sellerId: caller.sellerId,
      actor: caller.actor,
      code: oauthCode,
      state: oauthState,
    });
  }

  @Mutation(() => StorePaymentSetup, {
    name: 'disconnectMercadoPago',
    description:
      'Stops new sales from being charged to this Mercado Pago account. Refunds of past sales still work.',
  })
  async disconnectMercadoPago(
    @CurrentSeller() sellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    const caller = await this.caller({ sellerId, adminId, manage: true });
    return this.connect.disconnect(caller.sellerId);
  }

  /** A panel session acts through its admin; a web session is the business itself. */
  private async caller({
    sellerId,
    adminId,
    manage,
  }: {
    sellerId?: string;
    adminId?: string;
    manage: boolean;
  }): Promise<PayoutCaller> {
    if (adminId) {
      const store = await businessAdminSeller(this.prisma, { adminId, manage });
      return { sellerId: store, actor: `admin:${adminId}`, surface: 'panel' };
    }
    if (sellerId) {
      await assertBusinessSeller(this.prisma, sellerId);
      return { sellerId, actor: `seller:${sellerId}`, surface: 'web' };
    }
    throw new UnauthorizedError('Debe iniciar sesión');
  }
}
