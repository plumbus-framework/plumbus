import { createJwtAdapter, signJwt } from '@plumbus/core';
import type { AuthContext } from '@plumbus/core';

export interface VoiceSessionTokenClaims {
  voiceName: string;
  sessionId: string;
  transport: 'livekit' | 'websocket';
  room?: string;
  identity?: string;
}

export interface MintVoiceSessionTokenArgs {
  secret: string;
  auth: AuthContext;
  claims: VoiceSessionTokenClaims;
  issuer?: string;
  expiresInSeconds?: number;
}

export interface VerifiedVoiceSessionToken {
  auth: AuthContext;
  claims: VoiceSessionTokenClaims;
  expiresAt?: Date;
}

const DEFAULT_EXPIRES_IN_SECONDS = 90;

export function mintVoiceSessionToken(args: MintVoiceSessionTokenArgs): string {
  return signJwt({
    secret: args.secret,
    sub: args.auth.userId ?? 'anonymous',
    roles: args.auth.roles,
    scopes: args.auth.scopes,
    tenantId: args.auth.tenantId,
    issuer: args.issuer,
    expiresIn: args.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS,
    claims: {
      sid: args.auth.sessionId,
      voice_name: args.claims.voiceName,
      voice_session_id: args.claims.sessionId,
      voice_transport: args.claims.transport,
      voice_room: args.claims.room,
      voice_identity: args.claims.identity,
      voice_purpose: 'voice-session',
    },
  });
}

export async function verifyVoiceSessionToken(args: {
  token: string;
  secret: string;
  issuer?: string;
}): Promise<VerifiedVoiceSessionToken | null> {
  const adapter = createJwtAdapter({
    secret: args.secret,
    issuer: args.issuer,
    claimMapping: { tenantId: 'tenant_id' },
  });
  const auth = await adapter.authenticate(`Bearer ${args.token}`);
  if (!auth) return null;

  const payload = decodeJwtPayload(args.token);
  if (!payload || payload.voice_purpose !== 'voice-session') return null;
  if (
    typeof payload.voice_name !== 'string' ||
    typeof payload.voice_session_id !== 'string' ||
    (payload.voice_transport !== 'websocket' && payload.voice_transport !== 'livekit')
  ) {
    return null;
  }

  return {
    auth,
    claims: {
      voiceName: payload.voice_name,
      sessionId: payload.voice_session_id,
      transport: payload.voice_transport,
      room: typeof payload.voice_room === 'string' ? payload.voice_room : undefined,
      identity: typeof payload.voice_identity === 'string' ? payload.voice_identity : undefined,
    },
    expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : undefined,
  };
}

function decodeJwtPayload(token: string): Record<string, any> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;

  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, any>;
  } catch {
    return null;
  }
}
