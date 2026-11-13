import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchWithTimeout } from './fetch-with-timeout.js';

describe('fetchWithTimeout (INF-24)', () => {
  let server: Server;
  let url: string;
  const pending = new Set<NodeJS.Timeout>();

  // Answers after 300 ms.
  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = createServer((_req, res) => {
          const timer = setTimeout(() => {
            pending.delete(timer);
            res.end('late');
          }, 300);
          pending.add(timer);
        });
        server.listen(0, '127.0.0.1', () => {
          url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
          resolve();
        });
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        pending.forEach((timer) => clearTimeout(timer));
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  it('gives up once the limit passes', async () => {
    const started = Date.now();

    await expect(fetchWithTimeout(url, {}, 50)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(Date.now() - started).toBeLessThan(290);
  });

  it('returns the answer when it comes in time', async () => {
    const res = await fetchWithTimeout(url, { method: 'POST' }, 2_000);

    expect(await res.text()).toBe('late');
  });

  it("leaves the caller's own signal alone", async () => {
    const own = new AbortController();
    own.abort(new Error('caller gave up'));

    await expect(
      fetchWithTimeout(url, { signal: own.signal }, 2_000),
    ).rejects.toThrow('caller gave up');
  });
});
