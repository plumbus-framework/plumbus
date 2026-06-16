import { describe, expect, it } from 'vitest';
import { mockAI } from '@plumbus/core/testing';
import { createTestContext } from '@plumbus/core/testing';
import { recordLiveKitTransportCost } from '../record-livekit-transport.js';

describe('recordLiveKitTransportCost', () => {
  it('records a transport row with participant minutes on session teardown', async () => {
    const recorded: unknown[] = [];
    const ctx = createTestContext({
      ai: {
        ...mockAI(),
        async recordProviderCost(record) {
          recorded.push(record);
        },
      },
    });

    await recordLiveKitTransportCost(ctx, {
      sessionId: 'livekit:voice:worker:abc',
      connectedAt: new Date('2026-01-01T00:00:00.000Z'),
      disconnectedAt: new Date('2026-01-01T00:02:00.000Z'),
      participantCount: 2,
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      operation: 'transport',
      provider: 'livekit',
      model: 'livekit-cloud',
      mediaUsage: {
        connectionMinutes: 2,
        participantMinutes: 4,
      },
    });
  });
});
