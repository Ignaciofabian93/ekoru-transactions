import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** How long a store has to finish authorizing on Mercado Pago. */
export const CONNECT_STATE_TTL_MS = 15 * 60_000;

export interface ConnectState {
  /** The store being connected. */
  sellerId: string;
  /** The business admin who started it; only they can finish it. */
  adminId: string;
  /** Epoch ms after which the state is refused. */
  expiresAt: number;
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

function mac(key: string, message: string): Buffer {
  return createHmac('sha256', key).update(message).digest();
}

/**
 * The OAuth `state`: who started the connection, until when, signed so it
 * cannot be forged or replayed for another store. No server-side storage —
 * the signature is the proof.
 */
export function signConnectState(
  { sellerId, adminId, expiresAt }: ConnectState,
  key: string,
): string {
  const body = b64url(
    JSON.stringify({
      s: sellerId,
      a: adminId,
      e: expiresAt,
      n: randomBytes(9).toString('base64url'),
    }),
  );
  return `${body}.${b64url(mac(key, body))}`;
}

/** The state's content when the signature holds and it has not expired, else null. */
export function readConnectState(
  state: string,
  key: string,
  now: number = Date.now(),
): ConnectState | null {
  const dot = state.indexOf('.');
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const given = Buffer.from(state.slice(dot + 1), 'base64url');
  const expected = mac(key, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      s?: unknown;
      a?: unknown;
      e?: unknown;
    };
    if (
      typeof parsed.s !== 'string' ||
      typeof parsed.a !== 'string' ||
      typeof parsed.e !== 'number' ||
      parsed.e < now
    ) {
      return null;
    }
    return { sellerId: parsed.s, adminId: parsed.a, expiresAt: parsed.e };
  } catch {
    return null;
  }
}

/**
 * PKCE verifier for a connection, derived from its state so nothing has to be
 * stored between the redirect and the callback. 43 base64url characters, the
 * RFC 7636 minimum, and secret because the key is.
 */
export function pkceVerifier(state: string, key: string): string {
  return b64url(mac(key, `pkce:${state}`));
}

/** S256 challenge of a verifier. */
export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}
