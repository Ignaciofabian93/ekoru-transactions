import {
  assertAdminCan,
  assertPartyOrAdmin,
  businessAdminSeller,
  requireSeller,
  sellerScope,
} from './admin-access.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Row = {
  adminType: string;
  role: string;
  permissions: string[];
  isActive: boolean;
};

const prismaWith = (row?: Partial<Row>) =>
  ({
    $queryRaw: jest.fn().mockResolvedValue(
      row
        ? [
            {
              adminType: 'PLATFORM',
              role: 'MODERATOR',
              permissions: [],
              isActive: true,
              ...row,
            },
          ]
        : [],
    ),
  }) as unknown as PrismaService;

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { extensions?: { code?: string } }).extensions?.code;
  }
};

describe('assertAdminCan (SEC-8, TRX-8)', () => {
  it('refuses signed out as UNAUTHORIZED and everyone else as FORBIDDEN', async () => {
    expect(
      await codeOf(assertAdminCan(prismaWith(), undefined, 'MANAGE_SETTINGS')),
    ).toBe('UNAUTHORIZED');
    expect(
      await codeOf(
        assertAdminCan(
          prismaWith({ adminType: 'BUSINESS', role: 'SUPER_ADMIN' }),
          'a1',
          'MANAGE_SETTINGS',
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await codeOf(
        assertAdminCan(
          prismaWith({ permissions: ['VIEW_TRANSACTIONS'] }),
          'a1',
          'PROCESS_REFUNDS',
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('accepts the permission or SUPER_ADMIN', async () => {
    expect(
      await codeOf(
        assertAdminCan(
          prismaWith({ permissions: ['PROCESS_REFUNDS'] }),
          'a1',
          'PROCESS_REFUNDS',
        ),
      ),
    ).toBe('OK');
    expect(
      await codeOf(
        assertAdminCan(prismaWith({ role: 'SUPER_ADMIN' }), 'a1', [
          'VIEW_ANALYTICS',
          'VIEW_TRANSACTIONS',
        ]),
      ),
    ).toBe('OK');
  });
});

describe('assertPartyOrAdmin (TRX-1)', () => {
  const parties = ['buyer', 'seller'];

  it('lets a party read without an admin lookup', async () => {
    const prisma = prismaWith();
    await expect(
      assertPartyOrAdmin(prisma, {
        sellerId: 'buyer',
        parties,
        permission: 'MANAGE_ORDERS',
      }),
    ).resolves.toBeUndefined();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses an unrelated seller and a signed-out caller', async () => {
    expect(
      await codeOf(
        assertPartyOrAdmin(prismaWith(), {
          sellerId: 'stranger',
          parties,
          permission: 'MANAGE_ORDERS',
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await codeOf(
        assertPartyOrAdmin(prismaWith(), {
          parties,
          permission: 'MANAGE_ORDERS',
        }),
      ),
    ).toBe('UNAUTHORIZED');
  });

  it('lets a platform admin with the permission read', async () => {
    expect(
      await codeOf(
        assertPartyOrAdmin(prismaWith({ permissions: ['MANAGE_ORDERS'] }), {
          adminId: 'a1',
          parties,
          permission: ['MANAGE_ORDERS', 'VIEW_TRANSACTIONS'],
        }),
      ),
    ).toBe('OK');
  });
});

describe('sellerScope (TRX-1)', () => {
  it("gives a seller their own records, never someone else's", async () => {
    await expect(
      sellerScope(prismaWith(), {
        sellerId: 's1',
        permission: 'VIEW_TRANSACTIONS',
      }),
    ).resolves.toBe('s1');
    expect(
      await codeOf(
        sellerScope(prismaWith(), {
          sellerId: 's1',
          requested: 's2',
          permission: 'VIEW_TRANSACTIONS',
        }),
      ),
    ).toBe('FORBIDDEN');
  });

  it('lets a platform admin name the seller, and requires it', async () => {
    const prisma = prismaWith({ permissions: ['VIEW_TRANSACTIONS'] });
    await expect(
      sellerScope(prisma, {
        adminId: 'a1',
        requested: 's2',
        permission: 'VIEW_TRANSACTIONS',
      }),
    ).resolves.toBe('s2');
    expect(
      await codeOf(
        sellerScope(prisma, { adminId: 'a1', permission: 'VIEW_TRANSACTIONS' }),
      ),
    ).toBe('BAD_REQUEST');
  });

  it('refuses a signed-out caller, who used to get any seller', async () => {
    expect(
      await codeOf(
        sellerScope(prismaWith(), {
          requested: 's2',
          permission: 'VIEW_TRANSACTIONS',
        }),
      ),
    ).toBe('UNAUTHORIZED');
  });
});

describe('requireSeller', () => {
  it('refuses a missing session instead of filtering on undefined', () => {
    expect(() => requireSeller(undefined)).toThrow();
    expect(requireSeller('s1')).toBe('s1');
  });
});

describe('businessAdminSeller (TRX-5)', () => {
  const business = (row: Partial<Row> & { sellerId?: string | null }) =>
    prismaWith({
      adminType: 'BUSINESS',
      role: 'BUSINESS_SUPPORT',
      sellerId: 'store-1',
      ...row,
    } as Partial<Row>);

  it("returns a business admin's own store", async () => {
    await expect(
      businessAdminSeller(business({}), { adminId: 'a1', manage: false }),
    ).resolves.toBe('store-1');
  });

  it('lets only the owner or a profile manager change it', async () => {
    expect(
      await codeOf(
        businessAdminSeller(business({}), { adminId: 'a1', manage: true }),
      ),
    ).toBe('FORBIDDEN');
    await expect(
      businessAdminSeller(business({ role: 'BUSINESS_OWNER' }), {
        adminId: 'a1',
        manage: true,
      }),
    ).resolves.toBe('store-1');
    await expect(
      businessAdminSeller(
        business({ permissions: ['MANAGE_BUSINESS_PROFILE'] }),
        { adminId: 'a1', manage: true },
      ),
    ).resolves.toBe('store-1');
  });

  it('refuses platform admins, inactive admins and the signed out', async () => {
    expect(
      await codeOf(
        businessAdminSeller(prismaWith({ role: 'SUPER_ADMIN' }), {
          adminId: 'a1',
          manage: false,
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await codeOf(
        businessAdminSeller(business({ isActive: false }), {
          adminId: 'a1',
          manage: false,
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await codeOf(
        businessAdminSeller(business({}), {
          adminId: undefined,
          manage: false,
        }),
      ),
    ).toBe('UNAUTHORIZED');
  });
});
