import { describe, expect, it } from 'vitest';
import { mintLiveKitParticipantToken } from '../livekit-transport.js';

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payloadSegment = token.split('.')[1];
  if (!payloadSegment) {
    throw new Error('JWT payload segment missing');
  }
  const normalized = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
}

describe('mintLiveKitParticipantToken', () => {
  it('mints a JWT for a participant', async () => {
    const token = await mintLiveKitParticipantToken({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      room: 'agent-room',
      identity: 'voice-user',
      ttlSeconds: 3600,
      attributes: { tenantId: 'tenant-1' },
    });

    expect(token.split('.')).toHaveLength(3);
  });

  it('includes roomConfig agent dispatch when agentName is provided', async () => {
    const token = await mintLiveKitParticipantToken({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      room: 'agent-room',
      identity: 'voice-user',
      metadata: JSON.stringify({ projectId: 'proj-1', language: 'he' }),
      agentName: 'interviewer',
      agentMetadata: JSON.stringify({ projectId: 'proj-1', language: 'he' }),
    });

    const payload = decodeJwtPayload(token);
    const roomConfig = payload.roomConfig as {
      agents?: Array<{ agentName?: string; metadata?: string }>;
    };
    expect(roomConfig.agents?.[0]?.agentName).toBe('interviewer');
    expect(roomConfig.agents?.[0]?.metadata).toContain('proj-1');
    expect(roomConfig.agents?.[0]?.metadata).toContain('he');
  });

  it('omits roomConfig when agentName is not provided', async () => {
    const token = await mintLiveKitParticipantToken({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      room: 'agent-room',
      identity: 'voice-worker',
    });

    const payload = decodeJwtPayload(token);
    expect(payload.roomConfig).toBeUndefined();
  });
});
