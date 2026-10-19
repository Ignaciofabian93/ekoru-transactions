import { PrismaService } from '../prisma/prisma.service.js';
import {
  BadRequestError,
  ForbiddenError,
  UnauthorizedError,
} from './exceptions/index.js';

/** The admin permissions this subgraph checks (subset of the AdminPermission enum). */
export type AdminPermissionName =
  | 'MANAGE_SETTINGS'
  | 'MANAGE_ORDERS'
  | 'PROCESS_REFUNDS'
  | 'VIEW_TRANSACTIONS'
  | 'VIEW_ANALYTICS'
  | 'MODERATE_CONTENT';

type Permissions = AdminPermissionName | readonly AdminPermissionName[];

interface AdminRow {
  adminType: string;
  role: string;
  permissions: string[];
  isActive: boolean;
  sellerId: string | null;
}

/**
 * The Admin table belongs to ekoru-users, so it is read with raw SQL (the
 * cross-subgraph convention). Reading it per request means a deactivated admin
 * or a revoked permission takes effect at once.
 */
async function loadAdmin(
  prisma: PrismaService,
  adminId: string,
): Promise<AdminRow | undefined> {
  const rows = await prisma.$queryRaw<AdminRow[]>`
    SELECT "adminType"::text     AS "adminType",
           "role"::text          AS "role",
           "permissions"::text[] AS "permissions",
           "isActive",
           "sellerId"
    FROM "Admin"
    WHERE "id" = ${adminId}
    LIMIT 1`;
  return rows[0];
}

const asList = (p: Permissions): readonly AdminPermissionName[] =>
  Array.isArray(p) ? p : [p as AdminPermissionName];

function isPlatformAdminWith(
  admin: AdminRow | undefined,
  accepted: readonly AdminPermissionName[],
): boolean {
  return (
    !!admin &&
    admin.isActive &&
    admin.adminType === 'PLATFORM' &&
    (admin.role === 'SUPER_ADMIN' ||
      accepted.some((p) => (admin.permissions ?? []).includes(p)))
  );
}

/**
 * Ensures the caller is an active PLATFORM admin who is SUPER_ADMIN or holds
 * `permission` — the same rule ekoru-users applies (SEC-8). Returns the admin
 * id. Pass several permissions when any one of them is enough.
 *
 * A token only proves *who* the admin is. Before this check, any admin token,
 * including a BUSINESS admin's, could rewrite any store's payment config and
 * divert its payments, change fees, or resolve disputes. Refusal is FORBIDDEN,
 * not UNAUTHORIZED, so the panel keeps the session.
 */
export async function assertAdminCan(
  prisma: PrismaService,
  adminId: string | undefined,
  permission: Permissions,
): Promise<string> {
  const accepted = asList(permission);
  if (!adminId) throw new UnauthorizedError('Admin authentication required');
  if (!isPlatformAdminWith(await loadAdmin(prisma, adminId), accepted)) {
    throw new ForbiddenError(
      accepted.length === 1
        ? `This action requires the ${accepted[0]} permission`
        : `This action requires one of these permissions: ${accepted.join(', ')}`,
    );
  }
  return adminId;
}

/** Whether the caller is a platform admin with any of `permission`, without throwing. */
export async function isAdminWith(
  prisma: PrismaService,
  adminId: string | undefined,
  permission: Permissions,
): Promise<boolean> {
  if (!adminId) return false;
  return isPlatformAdminWith(
    await loadAdmin(prisma, adminId),
    asList(permission),
  );
}

/**
 * A record that belongs to some parties (an order's buyer and seller, a
 * payment's payer and receiver, a deal's two sides): a party reads it, and so
 * does a platform admin with `permission`. Anyone else is refused, and a
 * signed-out caller is told to sign in (TRX-1).
 */
export async function assertPartyOrAdmin(
  prisma: PrismaService,
  {
    sellerId,
    adminId,
    parties,
    permission,
  }: {
    sellerId?: string;
    adminId?: string;
    parties: (string | null | undefined)[];
    permission: Permissions;
  },
): Promise<void> {
  if (!sellerId && !adminId) throw new UnauthorizedError('Debe iniciar sesión');
  if (sellerId && parties.includes(sellerId)) return;
  if (await isAdminWith(prisma, adminId, permission)) return;
  throw new ForbiddenError('No tienes acceso a este registro');
}

/**
 * Whose records a list query returns (TRX-1). A signed-in seller always gets
 * their own; naming anyone else is refused. A platform admin with
 * `permission` names the seller to look at. The old queries took any seller
 * id from anyone, signed out included.
 */
export async function sellerScope(
  prisma: PrismaService,
  {
    sellerId,
    adminId,
    requested,
    permission,
  }: {
    sellerId?: string;
    adminId?: string;
    requested?: string | null;
    permission: Permissions;
  },
): Promise<string> {
  if (sellerId) {
    if (requested && requested !== sellerId) {
      throw new ForbiddenError('Solo puedes ver tus propios registros');
    }
    return sellerId;
  }
  if (adminId) {
    await assertAdminCan(prisma, adminId, permission);
    if (!requested) throw new BadRequestError('Indica el vendedor');
    return requested;
  }
  throw new UnauthorizedError('Debe iniciar sesión');
}

/**
 * The store a BUSINESS admin works for. With `manage`, they must also be able
 * to change the business's settings: the owner, or anyone holding
 * MANAGE_BUSINESS_PROFILE. Used for the store's own payout account (TRX-5),
 * which a business sets up in the panel.
 */
export async function businessAdminSeller(
  prisma: PrismaService,
  { adminId, manage }: { adminId?: string; manage: boolean },
): Promise<string> {
  if (!adminId) throw new UnauthorizedError('Admin authentication required');
  const admin = await loadAdmin(prisma, adminId);
  if (!admin?.isActive || admin.adminType !== 'BUSINESS' || !admin.sellerId) {
    throw new ForbiddenError('Solo una cuenta de empresa puede hacer esto');
  }
  if (
    manage &&
    admin.role !== 'BUSINESS_OWNER' &&
    !(admin.permissions ?? []).includes('MANAGE_BUSINESS_PROFILE')
  ) {
    throw new ForbiddenError(
      'Solo quien administra la empresa puede cambiar cómo recibe los pagos',
    );
  }
  return admin.sellerId;
}

/**
 * A signed-in business seller (STARTUP or COMPANY), for what a business sets
 * up for itself on the web, like its payout account. Signing in already
 * requires EKORU's approval of the business.
 */
export async function assertBusinessSeller(
  prisma: PrismaService,
  sellerId: string,
): Promise<string> {
  const rows = await prisma.$queryRaw<{ sellerType: string }[]>`
    SELECT "sellerType"::text AS "sellerType"
    FROM "Seller"
    WHERE "id" = ${sellerId}
    LIMIT 1`;
  const type = rows[0]?.sellerType;
  if (type !== 'STARTUP' && type !== 'COMPANY') {
    throw new ForbiddenError('Solo una cuenta de empresa puede hacer esto');
  }
  return sellerId;
}

/** The session seller, or UNAUTHORIZED. For `my*` queries. */
export function requireSeller(sellerId: string | undefined): string {
  if (!sellerId) throw new UnauthorizedError('Debe iniciar sesión');
  return sellerId;
}
