import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { PlumbusError } from '../errors/index.js';
import type { RequestAdmissionChallenge } from './shared.js';
import { requestAdmissionProofSchema, satisfiesAdmissionWork } from './shared.js';

const settingsSchema = z.object({
  signingKey: z.string().min(32),
  difficulty: z.number().int().min(12).max(22).default(18),
  ttlSeconds: z.number().int().min(60).max(900).default(300),
});
const envelopeSchema = z
  .object({
    v: z.literal(1),
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    binding: z.string().regex(/^[a-f0-9]{64}$/),
    difficulty: z.number().int().min(12).max(22),
    expiresAt: z.number().int().positive(),
  })
  .strict();
const equal = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** App policy decides when work is required; verification never grants authentication authority. */
export function createRequestAdmission(settings: z.input<typeof settingsSchema>) {
  const checked = settingsSchema.safeParse(settings);
  if (!checked.success)
    throw new PlumbusError('validation', 'Invalid request admission configuration');
  const config = checked.data;
  const key = createHmac('sha256', config.signingKey)
    .update('plumbus/request-admission/v1')
    .digest();
  const mac = (value: string) => createHmac('sha256', key).update(value).digest('hex');
  return {
    challenge(binding: string, now = Date.now()): RequestAdmissionChallenge {
      const expiresAt = now + config.ttlSeconds * 1000;
      const payload = Buffer.from(
        JSON.stringify({
          v: 1,
          nonce: randomBytes(32).toString('hex'),
          binding: mac(binding),
          difficulty: config.difficulty,
          expiresAt,
        }),
      ).toString('base64url');
      return { token: `${payload}.${mac(payload)}`, difficulty: config.difficulty, expiresAt };
    },
    /** Returns a replay key. Persist it uniquely in the same transaction as the admitted action. */
    verify(proof: unknown, binding: string, now = Date.now()): string | undefined {
      const parsed = requestAdmissionProofSchema.safeParse(proof);
      if (!parsed.success) return undefined;
      const parts = parsed.data.token.split('.');
      if (parts.length !== 2) return undefined;
      const [payload, signature] = parts;
      if (!payload || !signature || !equal(mac(payload), signature)) return undefined;
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      } catch {
        return undefined;
      }
      const envelope = envelopeSchema.safeParse(raw);
      if (
        !envelope.success ||
        !equal(envelope.data.binding, mac(binding)) ||
        envelope.data.difficulty !== config.difficulty ||
        envelope.data.expiresAt <= now ||
        envelope.data.expiresAt > now + config.ttlSeconds * 1000
      )
        return undefined;
      if (
        !satisfiesAdmissionWork(parsed.data.token, parsed.data.solution, envelope.data.difficulty)
      )
        return undefined;
      return createHash('sha256').update(parsed.data.token).digest('hex');
    },
  };
}

/** Serialize admission count/check/write on an app's already-bound database, across processes. */
export async function withRequestAdmissionLock<T>(
  db: PostgresJsDatabase,
  key: string,
  work: (transaction: PostgresJsDatabase) => Promise<T>,
): Promise<T> {
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`plumbus/admission:${key}`}, 0))`,
    );
    return work(transaction);
  });
}
