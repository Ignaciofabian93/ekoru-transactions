import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLResolveInfo,
} from 'graphql';
import { lastValueFrom, of, throwError } from 'rxjs';
import {
  AdminActivityInterceptor,
  describeActivity,
  LogsOwnActivity,
} from './admin-activity.interceptor';
import { PrismaService } from '../prisma/prisma.service';

const Thing = new GraphQLObjectType({
  name: 'Thing',
  fields: { id: { type: GraphQLID } },
});

const info = (
  fieldName: string,
  parent = 'Mutation',
  returnType: GraphQLResolveInfo['returnType'] = new GraphQLNonNull(Thing),
) =>
  ({
    fieldName,
    returnType,
    parentType: { name: parent },
  }) as unknown as GraphQLResolveInfo;

describe('describeActivity', () => {
  it('names the action and takes the entity from the returned object', () => {
    expect(
      describeActivity(
        info('refundPayment'),
        { paymentId: 'p1', language: 'ES' },
        {
          id: 7,
        },
      ),
    ).toEqual({
      action: 'REFUND_PAYMENT',
      entityType: 'Thing',
      entityId: '7',
      changes: JSON.stringify({ paymentId: 'p1' }),
    });
  });

  it('falls back to the id it was given when the mutation returns a scalar', () => {
    const row = describeActivity(
      info('deleteThingByAdmin', 'Mutation', GraphQLBoolean),
      { id: 12 },
      true,
    );
    expect(row.entityType).toBeNull();
    expect(row.entityId).toBe('12');
  });

  it('redacts secrets, counts long lists and cuts long strings', () => {
    const row = describeActivity(
      info('updateThing'),
      {
        input: {
          id: 'a',
          password: 'hunter2',
          rows: Array.from({ length: 50 }, (_, i) => i),
          note: 'x'.repeat(400),
        },
      },
      null,
    );
    const changes = JSON.parse(row.changes as string) as {
      input: Record<string, unknown>;
    };
    expect(row.entityId).toBe('a');
    expect(changes.input.password).toBe('[redacted]');
    expect(changes.input.rows).toEqual({ count: 50 });
    expect((changes.input.note as string).length).toBe(301);
  });
});

describe('AdminActivityInterceptor', () => {
  const owned = LogsOwnActivity();
  class Handlers {
    plain() {}
    @owned
    ownLog() {}
  }

  const record = jest.fn();
  const prisma = {
    $executeRaw: record,
    adminActivityLog: { create: record },
  } as unknown as PrismaService;
  const interceptor = new AdminActivityInterceptor(prisma, new Reflector());

  const context = (
    gqlInfo: GraphQLResolveInfo,
    ctx: Record<string, unknown>,
    handler: () => void = Handlers.prototype.plain,
  ) =>
    ({
      getType: () => 'graphql',
      getArgs: () => [undefined, { id: 'x' }, ctx, gqlInfo],
      getClass: () => Handlers,
      getHandler: () => handler,
    }) as unknown as ExecutionContext;

  const run = (ctx: ExecutionContext, result = of({ id: 'x' })) =>
    lastValueFrom(
      interceptor.intercept(ctx, { handle: () => result } as CallHandler),
    );

  beforeEach(() => {
    record.mockReset();
    record.mockResolvedValue(undefined);
  });

  it('records a mutation an admin ran', async () => {
    await run(context(info('approveThing'), { adminId: 'admin-1' }));
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('ignores queries, non-admin callers and self-logging mutations', async () => {
    await run(context(info('things', 'Query'), { adminId: 'admin-1' }));
    await run(context(info('approveThing'), { sellerId: 'seller-1' }));
    await run(
      context(
        info('approveThing'),
        { adminId: 'admin-1' },
        Handlers.prototype.ownLog,
      ),
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('records nothing when the mutation fails', async () => {
    await expect(
      run(
        context(info('approveThing'), { adminId: 'admin-1' }),
        throwError(() => new Error('nope')),
      ),
    ).rejects.toThrow('nope');
    expect(record).not.toHaveBeenCalled();
  });

  it('never fails the mutation when the write fails', async () => {
    record.mockRejectedValue(new Error('db down'));
    await expect(
      run(context(info('approveThing'), { adminId: 'admin-1' })),
    ).resolves.toEqual({ id: 'x' });
  });
});
