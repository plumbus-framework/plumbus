import { describe, expect, it } from 'vitest';
import { mintVoiceSessionToken, verifyVoiceSessionToken } from '../session-token.js';

const SECRET = 'voice-session-secret-for-tests-1234567890';

describe('voice session token', () => {
  it('accepts any non-empty transport id (not a hard-coded vendor list)', async () => {
    const token = mintVoiceSessionToken({
      secret: SECRET,
      auth: {
        userId: 'user-1',
        roles: ['user'],
        scopes: [],
        provider: 'jwt',
        tenantId: 'tenant-1',
      },
      claims: {
        voiceName: 'assistant',
        sessionId: 'session-1',
        transport: 'room',
        room: 'room-1',
        identity: 'user-1',
      },
    });

    const verified = await verifyVoiceSessionToken({ token, secret: SECRET });
    expect(verified).toMatchObject({
      claims: {
        voiceName: 'assistant',
        sessionId: 'session-1',
        transport: 'room',
        room: 'room-1',
        identity: 'user-1',
      },
    });
  });

  it('rejects empty transport ids', async () => {
    const token = mintVoiceSessionToken({
      secret: SECRET,
      auth: {
        userId: 'user-1',
        roles: ['user'],
        scopes: [],
        provider: 'jwt',
      },
      claims: {
        voiceName: 'assistant',
        sessionId: 'session-1',
        transport: '',
      },
    });

    await expect(verifyVoiceSessionToken({ token, secret: SECRET })).resolves.toBeNull();
  });
});
