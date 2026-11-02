import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadVoiceSession } from '../load-voice-session.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function codeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('loadVoiceSession', () => {
  it('uses @plumbus/voice/session when the installed voice has it', async () => {
    const session = { discoverVoices: () => [] };
    const root = vi.fn();
    expect(await loadVoiceSession({ session: async () => session, root })).toBe(session);
    expect(root).not.toHaveBeenCalled();
  });

  it('falls back to the @plumbus/voice root for voice 0.6.0, which has no session entry', async () => {
    const root = { discoverVoices: () => [] };
    const loaded = await loadVoiceSession({
      session: async () => {
        throw codeError('ERR_PACKAGE_PATH_NOT_EXPORTED');
      },
      root: async () => root,
    });
    expect(loaded).toBe(root);
  });

  it('exits with the install hint when voice is not installed', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      loadVoiceSession({
        session: async () => {
          throw codeError('ERR_MODULE_NOT_FOUND');
        },
        root: async () => ({}),
      }),
    ).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
