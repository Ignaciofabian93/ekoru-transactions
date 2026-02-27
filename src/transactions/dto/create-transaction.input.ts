import { InputType, Field, Int } from '@nestjs/graphql';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { TransactionKind } from '../../graphql/enums/index.js';

@InputType()
export class CreateTransactionInput {
  @Field(() => TransactionKind)
  @IsEnum(TransactionKind)
  kind: TransactionKind;

  @Field(() => Int)
  @IsNumber()
  @Min(0)
  pointsCollected: number;

  @Field(() => String)
  @IsString()
  sellerId: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  transactionFeeId?: number;
}

@InputType()
export class CreateExchangeInput {
  @Field(() => Int)
  @IsNumber()
  transactionId: number;

  @Field(() => Int)
  @IsNumber()
  offeredProductId: number;

  @Field(() => Int)
  @IsNumber()
  requestedProductId: number;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}
