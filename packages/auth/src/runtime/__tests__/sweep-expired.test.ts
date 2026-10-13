import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepExpired } from '../create-runtime.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sweepExpired', () => {
  it('logs a failed sweep instead of rejecting', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      sweepExpired('sessions', () => Promise.reject(new Error('CONNECT_TIMEOUT'))),
    ).resolves.toBeUndefined();

    expect(consoleWarn).toHaveBeenCalledWith(
      '[@plumbus/auth] expired sessions sweep failed; retrying next sweep',
      { error: 'CONNECT_TIMEOUT' },
    );
  });

  it('stays quiet when the sweep succeeds', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sweepExpired('login transactions', () => Promise.resolve(3));

    expect(consoleWarn).not.toHaveBeenCalled();
  });
});
