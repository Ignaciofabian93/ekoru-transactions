import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import {
  Args,
  Field,
  GraphQLModule,
  InputType,
  Int,
  Mutation,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { IsInt, IsOptional, Max } from 'class-validator';
import request from 'supertest';
import {
  capListSizes,
  ListSizeCapInterceptor,
  MAX_LIST_SIZE,
} from './list-size-cap.interceptor';

describe('capListSizes (GW-6)', () => {
  it('lowers a list size above the cap and leaves the rest alone', () => {
    const args = { pageSize: 100_000, page: 9_000, search: 'mesa' };

    capListSizes(args);

    expect(args).toEqual({
      pageSize: MAX_LIST_SIZE,
      page: 9_000,
      search: 'mesa',
    });
  });

  it.each(['pageSize', 'limit', 'take', 'first'])('caps %s', (key) => {
    const args = { [key]: MAX_LIST_SIZE + 1 };

    capListSizes(args);

    expect(args[key]).toBe(MAX_LIST_SIZE);
  });

  it('keeps a size at or under the cap, zero and negatives included', () => {
    const args = { pageSize: MAX_LIST_SIZE, limit: 12, take: 0, first: -1 };

    capListSizes(args);

    expect(args).toEqual({
      pageSize: MAX_LIST_SIZE,
      limit: 12,
      take: 0,
      first: -1,
    });
  });

  it('reaches sizes inside input objects', () => {
    const args = {
      input: { filter: { limit: 9_999 }, pagination: { take: 9_999 } },
    };

    capListSizes(args);

    expect(args.input.filter.limit).toBe(MAX_LIST_SIZE);
    expect(args.input.pagination.take).toBe(MAX_LIST_SIZE);
  });

  it('ignores lists, text that looks like a size, and missing arguments', () => {
    const args = { ids: [9_999, 9_998], pageSize: '9999' };

    capListSizes(args);
    capListSizes(undefined);
    capListSizes(null);

    expect(args).toEqual({ ids: [9_999, 9_998], pageSize: '9999' });
  });
});

@InputType()
class ProbeListInput {
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  limit?: number;
}

@InputType()
class ProbeStrictInput {
  @Field(() => Int)
  @IsInt()
  @Max(100)
  pageSize: number;
}

@Resolver()
class ProbeResolver {
  @Query(() => Int)
  listSize(@Args('pageSize', { type: () => Int }) pageSize: number): number {
    return pageSize;
  }

  @Query(() => Int)
  inputSize(@Args('input') input: ProbeListInput): number {
    return input.limit ?? -1;
  }

  @Query(() => Int)
  strictSize(@Args('input') input: ProbeStrictInput): number {
    return input.pageSize;
  }

  @Mutation(() => Int)
  storeLimit(@Args('limit', { type: () => Int }) limit: number): number {
    return limit;
  }
}

/** The interceptor on a running GraphQL server, wired as in app.module.ts. */
describe('ListSizeCapInterceptor (GW-6)', () => {
  let app: INestApplication;
  const run = async (query: string) => {
    const res = await request(app.getHttpServer())
      .post('/graphql')
      .send({ query });
    return res.body as {
      data?: Record<string, number>;
      errors?: Array<{ message: string }>;
    };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        GraphQLModule.forRoot<ApolloDriverConfig>({
          driver: ApolloDriver,
          autoSchemaFile: true,
        }),
      ],
      providers: [
        ProbeResolver,
        { provide: APP_INTERCEPTOR, useClass: ListSizeCapInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // As main.ts does.
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
  });

  afterAll(() => app.close());

  it('gives the resolver the cap when a query asks for more', async () => {
    const { data } = await run('{ listSize(pageSize: 100000) }');

    expect(data).toEqual({ listSize: MAX_LIST_SIZE });
  });

  it('gives the resolver what a query asked for when it is under the cap', async () => {
    const { data } = await run('{ listSize(pageSize: 24) }');

    expect(data).toEqual({ listSize: 24 });
  });

  it('caps a size inside an input object', async () => {
    const { data } = await run('{ inputSize(input: { limit: 100000 }) }');

    expect(data).toEqual({ inputSize: MAX_LIST_SIZE });
  });

  it('still refuses what an input already limits lower', async () => {
    const { data, errors } = await run(
      '{ strictSize(input: { pageSize: 100000 }) }',
    );

    expect(data).toBeFalsy();
    expect(errors?.length).toBe(1);
  });

  it('leaves a mutation alone', async () => {
    const { data } = await run('mutation { storeLimit(limit: 100000) }');

    expect(data).toEqual({ storeLimit: 100_000 });
  });
});
