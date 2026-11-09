import { randomUUID } from 'node:crypto';
import { z } from '@plumbus/core/zod';
import { PlumbusError, ErrorCode } from '@plumbus/core/errors';
import { createJwtAdapter, signJwt } from '@plumbus/core/sdk';
import type { AuthContext } from '@plumbus/core';

export interface VoiceSessionTokenClaims {
  voiceName: string;
  sessionId: string;
  transport: string;
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
  /** Unique token id (`jti`); absent on tokens minted by voice < 0.6.2. */
  tokenId?: string;
}

const DEFAULT_EXPIRES_IN_SECONDS = 90;

export function mintVoiceSessionToken(args: MintVoiceSessionTokenArgs): string {
  if (
    !z
      .number()
      .finite()
      .int()
      .positive()
      .safeParse(args.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS).success
  )
    throw new PlumbusError(
      ErrorCode.Validation,
      'Voice handshake token lifetime must be a finite positive number of whole seconds',
    );
  return signJwt({
    secret: args.secret,
    sub: args.auth.userId ?? 'anonymous',
    roles: args.auth.roles,
    scopes: args.auth.scopes,
    tenantId: args.auth.tenantId,
    issuer: args.issuer,
    expiresIn: args.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS,
    claims: {
      jti: randomUUID(),
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
    typeof payload.voice_transport !== 'string' ||
    payload.voice_transport.length === 0
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
    tokenId: typeof payload.jti === 'string' && payload.jti.length > 0 ? payload.jti : undefined,
  };
}

/**
 * Bounded, in-process record of consumed handshake token ids, used when
 * `singleUseSessionTokens` is enabled. It is per process: with several API
 * replicas, a token can still be redeemed once on each replica within its
 * lifetime. Entries are dropped when the token expires; when the store is full,
 * expired entries are pruned first and then the oldest entries are evicted.
 */
export class ConsumedVoiceTokenStore {
  readonly #entries = new Map<string, number>();
  readonly #maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.#maxEntries = Math.max(1, maxEntries);
  }

  /** Returns true the first time a token id is seen (and records it), false on replay. */
  consume(tokenId: string, expiresAtMs: number, nowMs = Date.now()): boolean {
    const existing = this.#entries.get(tokenId);
    if (existing !== undefined && existing > nowMs) return false;
    if (existing !== undefined) this.#entries.delete(tokenId);
    if (this.#entries.size >= this.#maxEntries) {
      for (const [id, exp] of this.#entries) {
        if (exp <= nowMs) this.#entries.delete(id);
      }
      while (this.#entries.size >= this.#maxEntries) {
        const oldest = this.#entries.keys().next().value;
        if (oldest === undefined) break;
        this.#entries.delete(oldest);
      }
    }
    this.#entries.set(tokenId, expiresAtMs);
    return true;
  }

  get size(): number {
    return this.#entries.size;
  }
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
