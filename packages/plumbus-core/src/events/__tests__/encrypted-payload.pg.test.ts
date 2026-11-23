// A secret in an event payload stays encrypted at rest when the emitter encrypts it with
// `encryptFieldValue` and the consumer decrypts it with `decryptFieldValue`: the event outbox
// row on a real PostgreSQL holds only the ciphertext.

import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decryptFieldValue, encryptFieldValue } from '../../data/field-encryption.js';
import { defineEvent } from '../../define/defineEvent.js';
import { eventOutboxDdl } from '../../durable/apply-ddl.js';
import { createDurableTestDatabase } from '../../durable/harness.js';
import { createEventEmitter } from '../emitter.js';
import { EventRegistry } from '../registry.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe('an encrypted field in an event payload', () => {
  it('is stored as ciphertext and decrypts to the exact value', async () => {
    const handle = await createDurableTestDatabase({
      kind: 'event_encrypted',
      ddl: eventOutboxDdl(),
    });
    closers.push(() => handle.close());
    const registry = new EventRegistry();
    registry.register(
      defineEvent({
        name: 'invoice.link_issued',
        domain: 'billing',
        version: '1',
        payload: z.object({ invoiceId: z.string(), accessToken: z.string() }),
      }),
    );
    const key = randomBytes(32); // In an app: resolveEncryptionKey() (PLUMBUS_ENCRYPTION_KEY).
    const token = `tok_${randomBytes(24).toString('base64url')}`;
    const events = createEventEmitter({
      db: handle.db,
      auth: { userId: 'clerk-1', roles: [], scopes: [], provider: 'test', tenantId: 't1' },
      registry,
    });
    await events.emit(
      'invoice.link_issued' as never,
      {
        invoiceId: 'inv-1',
        accessToken: encryptFieldValue(token, key),
      } as never,
    );
    const rows = (await handle.db.execute(sql`SELECT * FROM event_outbox`)) as unknown as Array<{
      payload: { accessToken: string };
    }>;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]?.payload.accessToken.startsWith('plumbus:enc:v1:')).toBe(true);
    // The consumer's side.
    expect(decryptFieldValue(rows[0]?.payload.accessToken ?? '', key)).toBe(token);
  });
});
