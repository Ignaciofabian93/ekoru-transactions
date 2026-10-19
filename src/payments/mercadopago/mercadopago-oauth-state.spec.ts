import { createHash } from 'node:crypto';
import {
  pkceChallenge,
  pkceVerifier,
  readConnectState,
  signConnectState,
} from './mercadopago-oauth-state.js';

const KEY = 'state-key';
const NOW = 1_760_000_000_000;

describe('Mercado Pago connect state', () => {
  const content = {
    sellerId: 'seller-1',
    actor: 'admin:admin-1',
    surface: 'panel' as const,
    expiresAt: NOW + 60_000,
  };

  it('reads back what it signed', () => {
    const state = signConnectState(content, KEY);
    expect(readConnectState(state, KEY, NOW)).toEqual(content);
  });

  it('differs on every start, so a state is never reused', () => {
    expect(signConnectState(content, KEY)).not.toEqual(
      signConnectState(content, KEY),
    );
  });

  it('refuses an expired state', () => {
    const state = signConnectState(content, KEY);
    expect(readConnectState(state, KEY, NOW + 120_000)).toBeNull();
  });

  it('refuses a state signed with another key', () => {
    const state = signConnectState(content, 'other-key');
    expect(readConnectState(state, KEY, NOW)).toBeNull();
  });

  it('refuses a state whose content was changed', () => {
    const state = signConnectState(content, KEY);
    const [, sig] = state.split('.');
    const forged = Buffer.from(
      JSON.stringify({ s: 'seller-2', a: 'admin-1', e: NOW + 60_000, n: 'x' }),
    ).toString('base64url');
    expect(readConnectState(`${forged}.${sig}`, KEY, NOW)).toBeNull();
  });

  it('refuses garbage', () => {
    expect(readConnectState('', KEY, NOW)).toBeNull();
    expect(readConnectState('no-dot', KEY, NOW)).toBeNull();
    expect(readConnectState('.abc', KEY, NOW)).toBeNull();
  });
});

describe('PKCE', () => {
  it('derives a stable RFC 7636 verifier from the state', () => {
    const verifier = pkceVerifier('some.state', KEY);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkceVerifier('some.state', KEY)).toBe(verifier);
    expect(pkceVerifier('other.state', KEY)).not.toBe(verifier);
  });

  it('challenges with S256', () => {
    const verifier = pkceVerifier('some.state', KEY);
    expect(pkceChallenge(verifier)).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    );
  });
});
