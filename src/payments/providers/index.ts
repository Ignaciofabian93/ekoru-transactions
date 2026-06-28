import { Injectable } from '@nestjs/common';
import { ChileanPaymentProvider } from '../../graphql/enums/index.js';
import type { ProviderAdapter } from './provider-adapter.js';
import { WebpayAdapter } from './webpay.adapter.js';
import { KhipuAdapter } from './khipu.adapter.js';
import { MercadoPagoAdapter } from './mercadopago.adapter.js';

/** Hands out the adapter for a given provider. Single injection point used by `PaymentsService`. */
@Injectable()
export class ProviderRegistry {
  constructor(
    private readonly webpay: WebpayAdapter,
    private readonly khipu: KhipuAdapter,
    private readonly mercadopago: MercadoPagoAdapter,
  ) {}

  for(provider: ChileanPaymentProvider): ProviderAdapter {
    switch (provider) {
      case ChileanPaymentProvider.WEBPAY:
        return this.webpay;
      case ChileanPaymentProvider.KHIPU:
        return this.khipu;
      case ChileanPaymentProvider.MERCADOPAGO:
        return this.mercadopago;
    }
  }
}

export { WebpayAdapter } from './webpay.adapter.js';
export { KhipuAdapter } from './khipu.adapter.js';
export { MercadoPagoAdapter } from './mercadopago.adapter.js';
export type {
  ProviderAdapter,
  InitiatePaymentArgs,
  InitiatePaymentResult,
  ConfirmPaymentArgs,
  ConfirmPaymentResult,
} from './provider-adapter.js';
