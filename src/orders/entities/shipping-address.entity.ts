import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

@ObjectType()
export class ShippingAddress {
  @Field(() => ID)
  id: number;

  @Field(() => String)
  recipientName: string;

  @Field(() => String)
  phone: string;

  @Field(() => Int)
  countryId: number;

  @Field(() => Int)
  regionId: number;

  @Field(() => Int)
  cityId: number;

  @Field(() => Int)
  countyId: number;

  @Field(() => String)
  street: string;

  @Field(() => String, { nullable: true })
  reference?: string;

  @Field(() => String, { nullable: true })
  zipCode?: string;

  @Field(() => Date)
  createdAt: Date;

  @Field(() => Date)
  updatedAt: Date;
}
