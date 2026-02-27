import { InputType, Field, Int, Float } from '@nestjs/graphql';
import { IsNumber, IsPositive, IsString, Min } from 'class-validator';

@InputType()
export class RefundPaymentInput {
  @Field(() => Int)
  @IsNumber()
  @Min(1)
  paymentId: number;

  @Field(() => Float)
  @IsNumber()
  @IsPositive()
  amount: number;

  @Field(() => String)
  @IsString()
  reason: string;
}
