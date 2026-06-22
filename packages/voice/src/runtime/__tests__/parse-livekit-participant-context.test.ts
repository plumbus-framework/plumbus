import { describe, expect, it } from 'vitest';
import {
  buildBrainInputFromParticipantContext,
  parseLiveKitParticipantContext,
} from '../parse-livekit-participant-context.js';

describe('parseLiveKitParticipantContext', () => {
  it('reads trusted session fields from participant metadata', () => {
    const context = parseLiveKitParticipantContext({
      roomName: 'session-123',
      participantIdentity: 'lk-participant',
      participantMetadata: JSON.stringify({
        projectId: 'project-1',
        sessionId: 'session-123',
        language: 'he',
        userId: 'user-9',
        tenantId: 'tenant-1',
      }),
    });

    expect(context).toMatchObject({
      projectId: 'project-1',
      sessionId: 'session-123',
      language: 'he',
      userId: 'user-9',
      tenantId: 'tenant-1',
    });
    expect(buildBrainInputFromParticipantContext(context)).toEqual({
      projectId: 'project-1',
      sessionId: 'session-123',
      language: 'he',
    });
  });

  it('falls back to the room name when metadata omits sessionId', () => {
    const context = parseLiveKitParticipantContext({
      roomName: 'room-only',
      participantIdentity: 'lk-participant',
    });

    expect(context.sessionId).toBe('room-only');
    expect(context.userId).toBe('lk-participant');
  });
});
