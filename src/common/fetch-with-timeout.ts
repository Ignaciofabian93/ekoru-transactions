/** What a call to another service gets unless it asks for more. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * `fetch` with a time limit (INF-24). Node's own limit is 5 minutes, so one
 * stuck service held every request that called it. Past the limit the call is
 * aborted and rejects with a `TimeoutError`, which callers treat like any
 * other failed call. A `signal` the caller passes is left alone.
 */
export function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
}
