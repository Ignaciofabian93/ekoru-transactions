import { ObjectType, Field } from '@nestjs/graphql';
import { Order } from './order.entity.js';
import { PageInfo } from '../../common/entities/index.js';

@ObjectType()
export class OrderConnection {
  @Field(() => [Order])
  nodes: Order[];

  @Field(() => PageInfo)
  pageInfo: PageInfo;
}
