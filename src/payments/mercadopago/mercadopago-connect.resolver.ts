import {
  Args,
  ArgsType,
  Field,
  Mutation,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentAdmin } from '../../common/decorators/index.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { businessAdminSeller } from '../../common/admin-access.js';
import { MercadoPagoConnectService } from './mercadopago-connect.service.js';
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

/**
 * A store sets up where its sales are paid, from the admin panel's business
 * area (TRX-5, WEB-2). Only BUSINESS admins, and only for their own store; the
 * owner or a MANAGE_BUSINESS_PROFILE holder may change it, any of the
 * business's admins may look. Platform admins see every connection in the
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
  async myStorePaymentSetup(@CurrentAdmin() adminId?: string) {
    const sellerId = await businessAdminSeller(this.prisma, {
      adminId,
      manage: false,
    });
    return this.connect.status(sellerId);
  }

  @Mutation(() => String, {
    name: 'startMercadoPagoConnection',
    description:
      'The Mercado Pago page to send the business to; it comes back to the panel with a code.',
  })
  async startMercadoPagoConnection(@CurrentAdmin() adminId?: string) {
    const sellerId = await businessAdminSeller(this.prisma, {
      adminId,
      manage: true,
    });
    return this.connect.authorizationUrl({ sellerId, adminId: adminId! });
  }

  @Mutation(() => StorePaymentSetup, { name: 'completeMercadoPagoConnection' })
  async completeMercadoPagoConnection(
    @Args() { oauthCode, oauthState }: CompleteMercadoPagoConnectionArgs,
    @CurrentAdmin() adminId?: string,
  ) {
    const sellerId = await businessAdminSeller(this.prisma, {
      adminId,
      manage: true,
    });
    return this.connect.complete({
      sellerId,
      adminId: adminId!,
      code: oauthCode,
      state: oauthState,
    });
  }

  @Mutation(() => StorePaymentSetup, {
    name: 'disconnectMercadoPago',
    description:
      'Stops new sales from being charged to this Mercado Pago account. Refunds of past sales still work.',
  })
  async disconnectMercadoPago(@CurrentAdmin() adminId?: string) {
    const sellerId = await businessAdminSeller(this.prisma, {
      adminId,
      manage: true,
    });
    return this.connect.disconnect(sellerId);
  }
}
