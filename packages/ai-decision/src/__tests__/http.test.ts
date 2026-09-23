import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createDecisionHttpTransport } from '../index.js';

describe('decision HTTP transport', () => {
  it('uses the configured prefix, sends auth, and disables redirects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"ok":true}'));
    const post = createDecisionHttpTransport('test', {
      baseUrl: 'https://example.test/prefix/v1/',
      apiKey: 'secret',
      fetch,
    });
    expect(await post({ state: 'text' })).toEqual({ ok: true });
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://example.test/prefix/v1/systemone');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
    });
  });

  it.each([429, 500, 502, 503, 504, 529])('retries HTTP %s with Retry-After', async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('busy', { status, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response('{}'));
    await createDecisionHttpTransport('test', { baseUrl: 'https://example.test/v1', fetch })({});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404, 422])('does not retry HTTP %s or expose its body', async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('private-state-and-key', { status }));
    const post = createDecisionHttpTransport('test', { baseUrl: 'https://example.test/v1', fetch });
    await expect(post({})).rejects.toMatchObject({ kind: 'http', httpStatus: status, attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds retry attempts', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        async () => new Response('', { status: 529, headers: { 'Retry-After': '0' } }),
      );
    await expect(
      createDecisionHttpTransport('test', {
        baseUrl: 'https://example.test',
        fetch,
        maxRetries: 1,
      })({}),
    ).rejects.toMatchObject({ attempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('includes retry waiting in the request deadline', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
    await expect(
      createDecisionHttpTransport('test', {
        baseUrl: 'https://example.test',
        fetch,
        timeoutMs: 20,
      })({}),
    ).rejects.toMatchObject({ kind: 'timeout', attempts: 1 });
  });

  it('cancels before dispatch without exposing the caller abort reason', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createDecisionHttpTransport('test', { baseUrl: 'https://example.test', fetch })(
        {},
        { signal: AbortSignal.abort('private-state') },
      ),
    ).rejects.toMatchObject({ kind: 'cancelled', attempts: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('interrupts a real fetch while its body is still streaming', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.write('{');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') return expect.fail('Expected TCP address');
    try {
      await expect(
        createDecisionHttpTransport('test', {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          timeoutMs: 40,
        })({}),
      ).rejects.toMatchObject({ kind: 'timeout' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    ['invalid JSON', 'not-json'],
    ['oversized body', 'x'.repeat(2 * 1024 * 1024 + 1)],
  ])('rejects %s', async (_name, body) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));
    await expect(
      createDecisionHttpTransport('test', { baseUrl: 'https://example.test', fetch })({}),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('rejects oversized requests before network IO', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createDecisionHttpTransport('test', { baseUrl: 'https://example.test', fetch })({
        state: 'x'.repeat(2 * 1024 * 1024),
      }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sanitizes network errors and does not retry uncertain delivery', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error('Authorization: Bearer secret'));
    await expect(
      createDecisionHttpTransport('test', { baseUrl: 'https://example.test', fetch })({}),
    ).rejects.toMatchObject({
      kind: 'network',
      message: 'Decision provider request failed',
      attempts: 1,
    });
  });

  it.each([
    'file:///tmp/socket',
    'https://key@example.test',
    'https://example.test?key=secret',
    'https://example.test/#fragment',
  ])('rejects unsuitable endpoint %s', (baseUrl) => {
    expect(() => createDecisionHttpTransport('test', { baseUrl })).toThrow();
  });
});
