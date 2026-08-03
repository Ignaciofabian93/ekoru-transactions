import { ObjectType, Field } from '@nestjs/graphql';
import { ChileanPaymentConfig } from '../../payments/entities/payment-config.entity.js';
import { PageInfo } from '../../common/entities/page-info.entity.js';

/**
 * Paginated admin view of ChileanPaymentConfig. Reuses the existing
 * `ChileanPaymentConfig` ObjectType (which already omits apiKey/secretKey).
 */
@ObjectType('AdminChileanPaymentConfigConnection')
export class ChileanPaymentConfigConnectionEntity {
  @Field(() => [ChileanPaymentConfig])
  nodes: ChileanPaymentConfig[];

  @Field(() => PageInfo)
  pageInfo: PageInfo;
}
