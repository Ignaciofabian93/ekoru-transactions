import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalServerError } from '../exceptions/index.js';
import { callSubgraph } from './subgraph-call.js';

/**
 * What a quotation costs and whether it can be charged, as ekoru-services
 * computes it (SRV-3): `finalPrice ?? estimatedPrice`.
 */
export interface QuotationCharge {
  id: string;
  title: string;
  status: string;
  clientId: string;
  providerId: string;
  amount: number | null;
  currency: string;
  paid: boolean;
  paidPaymentId: number | null;
}

const CHARGE_FIELDS = /* GraphQL */ `
  id
  title
  status
  clientId
  providerId
  amount
  currency
  paid
  paidPaymentId
`;

/**
 * Client over the services subgraph's internal quotation payment endpoints
 * (TRX-6). Both need INTERNAL_SERVICE_SECRET; the amount always comes from
 * services, never from the client.
 */
@Injectable()
export class ServicesClient {
  private readonly logger = new Logger(ServicesClient.name);

  constructor(private readonly config: ConfigService) {}

  async getQuotationCharge(quotationId: number): Promise<QuotationCharge> {
    const data = await this.call<{ quotationCharge: QuotationCharge }>(
      `query QuotationCharge($id: ID!) { quotationCharge(id: $id) { ${CHARGE_FIELDS} } }`,
      { id: String(quotationId) },
    );
    return data.quotationCharge;
  }

  /**
   * Stamps the quotation paid. Idempotent for the same payment; refused
   * (BAD_REQUEST) when another payment already paid it.
   */
  async markQuotationPaid({
    quotationId,
    paymentId,
  }: {
    quotationId: number;
    paymentId: number;
  }): Promise<QuotationCharge> {
    const data = await this.call<{ markQuotationPaid: QuotationCharge }>(
      `mutation MarkQuotationPaid($id: ID!, $paymentId: Int!) {
        markQuotationPaid(id: $id, paymentId: $paymentId) { ${CHARGE_FIELDS} }
      }`,
      { id: String(quotationId), paymentId },
    );
    return data.markQuotationPaid;
  }

  private call<T>(query: string, variables: Record<string, unknown>) {
    const secret = this.config.get<string>('internalSecret');
    if (!secret) {
      throw new InternalServerError('INTERNAL_SERVICE_SECRET no configurado');
    }
    return callSubgraph<T>({
      url: this.config.get<string>('subgraphs.services'),
      name: 'services',
      query,
      variables,
      internalSecret: secret,
      logger: this.logger,
    });
  }
}
