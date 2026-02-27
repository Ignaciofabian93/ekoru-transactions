import { ObjectType, Field } from '@nestjs/graphql';
import { Payment } from './payment.entity.js';
import { PageInfo } from '../../common/entities/index.js';

@ObjectType()
export class PaymentConnection {
  @Field(() => [Payment])
  nodes: Payment[];

  @Field(() => PageInfo)
  pageInfo: PageInfo;
}
