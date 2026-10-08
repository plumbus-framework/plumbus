// ── Clients: who pays ──
// A client is identified by the app's `reference`, a signed-in `userId`, or an
// `email`, within one seller (or the platform). Its provider customer lives
// where its charges do: on the seller's account for direct charges, on the
// platform for destination and platform charges.

import type { ExecutionContext } from '@plumbus/core';
import type { PaymentClientRow, PaymentMerchantAccountRow } from '../types/records.js';
import { clients, findOne, stableUuid } from './repos.js';
import { ownerMetadata, type PaymentsRuntime } from './runtime.js';

export interface ClientInput {
  email?: string;
  name?: string;
  reference?: string;
  userId?: string;
}

/** Whose clients: a seller's, or the platform's own (merchant null). */
export interface ClientScope {
  tenantId: string;
  merchant: PaymentMerchantAccountRow | null;
  /** The provider customer lives on the platform (destination and platform charges). */
  onPlatform: boolean;
  /** Metadata owner stamped on the provider customer. */
  owner: { tenantId: string; ownerType: string; ownerId: string };
}

/**
 * The client this input names. `reference` wins, then `userId`, then `email`; a
 * client found by a weaker identifier is only reused when it does not carry a
 * different reference or userId (two children can share a parent's email).
 */
export async function findClient(
  ctx: ExecutionContext,
  scope: ClientScope,
  input: ClientInput,
): Promise<PaymentClientRow | null> {
  const repo = clients(ctx);
  const base = {
    tenantId: scope.tenantId,
    merchantAccountId: scope.merchant?.id ?? null,
    onPlatform: scope.onPlatform,
  };
  const fits = (row: PaymentClientRow) =>
    (!input.reference || row.reference == null || row.reference === input.reference) &&
    (!input.userId || row.userId == null || row.userId === input.userId);
  if (input.reference) {
    const row = await findOne(repo, { ...base, reference: input.reference });
    if (row) return row;
  }
  for (const lookup of [
    input.userId ? { userId: input.userId } : null,
    input.email ? { email: input.email } : null,
  ]) {
    if (!lookup) continue;
    const row = (await repo.findMany({ ...base, ...lookup }, { limit: 100 })).find(fits);
    if (row) return row;
  }
  return null;
}

export async function ensureClient(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  scope: ClientScope,
  input: ClientInput,
): Promise<PaymentClientRow> {
  const repo = clients(ctx);
  const existing = await findClient(ctx, scope, input);
  if (existing) {
    // Remember identifiers the client was found without, so later lookups by them work.
    const missing = {
      ...(input.reference && existing.reference == null ? { reference: input.reference } : {}),
      ...(input.userId && existing.userId == null ? { userId: input.userId } : {}),
    };
    return Object.keys(missing).length > 0 ? repo.update(existing.id, missing) : existing;
  }

  // The id comes from the strongest identifier, so concurrent first charges for one
  // client create it once: same row id, same provider idempotency key.
  const identity = input.reference
    ? `reference:${input.reference}`
    : input.userId
      ? `user:${input.userId}`
      : `email:${input.email ?? ''}`;
  const where = scope.merchant
    ? `${scope.merchant.id}:${scope.onPlatform ? 'platform' : 'seller'}`
    : `platform:${scope.tenantId}`;
  const clientId = stableUuid(`plumbus-client:${where}:${identity}`);
  const created = await runtime.provider.createClient({
    sellerAccountId: scope.onPlatform ? null : (scope.merchant?.providerAccountId ?? null),
    ...(input.email ? { email: input.email } : {}),
    ...(input.name ? { name: input.name } : {}),
    metadata: ownerMetadata(runtime, scope.owner, { plumbus_client_id: clientId }),
    idempotencyKey: `plumbus-client:${clientId}`,
  });
  try {
    return await repo.create({
      id: clientId,
      tenantId: scope.tenantId,
      merchantAccountId: scope.merchant?.id ?? null,
      provider: runtime.provider.id,
      providerClientId: created.clientId,
      onPlatform: scope.onPlatform,
      reference: input.reference ?? null,
      userId: input.userId ?? null,
      email: input.email ?? null,
      name: input.name ?? null,
    });
  } catch (err) {
    const winner = await repo.findById(clientId);
    if (winner) return winner;
    throw err;
  }
}

/** JSON with sorted keys, for comparing flat metadata maps. */
export function canonicalJson(value: Record<string, string>): string {
  return JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
