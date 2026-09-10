import { expect, it } from 'vitest';
import { LiveKitTransportProvider } from '../transport/livekit-transport.js';

it('separates default rooms for the same user across tenants and preserves explicit room choices', async () => {
  const provider = new LiveKitTransportProvider(
    { url: 'wss://livekit.test', apiKey: 'key', apiSecret: 'secret-for-test-use-only-at-least-32' },
    { provider: 'livekit' },
  );
  const a = await provider.mintSession({ voiceName: 'voice', userId: 'user', tenantId: 'a' });
  const b = await provider.mintSession({ voiceName: 'voice', userId: 'user', tenantId: 'b' });
  expect(a.metadata?.room).not.toBe(b.metadata?.room);
  const shared = await provider.mintSession({
    voiceName: 'voice',
    userId: 'user',
    tenantId: 'a',
    roomName: 'approved-shared-room',
  });
  expect(shared.metadata?.room).toBe('approved-shared-room');
});
