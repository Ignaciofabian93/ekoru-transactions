import type { IncomingHttpHeaders } from 'http';
import { verify } from 'jsonwebtoken';

/**
 * Who is making this request.
 *
 * Derived from the **verified** access token, never from headers.
 *
 * The gateway sets `x-seller-id` / `x-admin-id` on every federated request, and
 * subgraphs used to read the identity straight out of them. Those headers are
 * unsigned strings: anything able to open a connection to a subgraph could
 * name any seller or admin it liked and be believed. That was survivable only
 * for as long as the subgraphs were unreachable, which made a compose file the
 * thing standing between an attacker and every account.
 *
 * Verifying the forwarded JWT here costs one HMAC per request and makes the
 * boundary real: the identity is now something the gateway *signed*, not
 * something a caller *claimed*.
 */
export interface RequestIdentity {
  sellerId?: string;
  adminId?: string;
  adminRole?: string;
  adminType?: string;
  /** For BUSINESS admins: the seller whose data they may touch. */
  adminSellerId?: string;
  /** The verified token, for onward service-to-service calls. */
  token?: string;
}

interface AccessClaims {
  sellerId?: string;
  adminId?: string;
  adminRole?: string;
  adminType?: string;
  adminSellerId?: string | null;
}

let warnedMissingSecret = false;

/**
 * Verifies the bearer token and returns the claims it carries.
 *
 * An absent or invalid token yields an empty identity rather than an error —
 * public queries are legitimate, and resolvers already reject anonymous callers
 * where that matters. What it must never do is fall back to trusting a header.
 */
export function resolveIdentity(headers: IncomingHttpHeaders): RequestIdentity {
  const raw = headers.authorization;
  const token = typeof raw === 'string' ? raw.replace(/^Bearer\s+/i, '') : '';
  if (!token) return {};

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // Misconfiguration, and a silent one: every request would look anonymous
    // and every authenticated feature would fail with a confusing error.
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      console.error(
        '[identity] JWT_SECRET is not set — all requests will be treated as anonymous',
      );
    }
    return {};
  }

  let claims: AccessClaims;
  try {
    claims = verify(token, secret) as AccessClaims;
  } catch {
    // Expired or forged. Anonymous, not trusted.
    return {};
  }

  return {
    sellerId: claims.sellerId,
    adminId: claims.adminId,
    adminRole: claims.adminRole,
    adminType: claims.adminType,
    adminSellerId: claims.adminSellerId ?? undefined,
    token,
  };
}
