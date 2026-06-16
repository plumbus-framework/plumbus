import { describe, expect, it } from 'vitest';
import { mintLiveKitParticipantToken } from '../livekit-transport.js';

describe('mintLiveKitParticipantToken', () => {
  it('mints a JWT for a participant', async () => {
    const token = await mintLiveKitParticipantToken({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      room: 'dvora-room',
      identity: 'voice-user',
      ttlSeconds: 3600,
      attributes: { tenantId: 'tenant-1' },
    });

    expect(token.split('.')).toHaveLength(3);
  });
});
