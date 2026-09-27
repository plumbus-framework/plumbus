// ── Typed repository accessors ──
// ctx.data is keyed by entity name. These accessors give the payments code
// typed rows without depending on the app's generated registry.

import { createHash } from 'node:crypto';
import type { ExecutionContext, QueryOptions } from '@plumbus/core';
import { PaymentEntityName } from '../entities/index.js';
import type {
  PaymentChargeRow,
  PaymentClientRow,
  PaymentDisputeRow,
  PaymentMerchantAccountRow,
  PaymentProviderEventRow,
  PaymentRefundRow,
} from '../types/records.js';

export interface TypedRepo<T> {
  findById(id: string): Promise<T | null>;
  findMany(query?: Partial<T>, options?: QueryOptions): Promise<T[]>;
  create(data: Partial<T>): Promise<T>;
  update(id: string, updates: Partial<T>): Promise<T>;
  /** Compare-and-set update (framework repositories always provide it). */
  updateWhere?(
    id: string,
    predicate: Partial<T>,
    updates: Partial<T>,
  ): Promise<{ matched: boolean; row: T | null }>;
  delete(id: string): Promise<void>;
}

function repo<T>(ctx: ExecutionContext, name: string): TypedRepo<T> {
  const found = (ctx.data as Record<string, unknown>)[name];
  if (!found) {
    throw ctx.errors.internal(
      `Entity "${name}" is not registered. Re-export the @plumbus/payments entities from app/entities.`,
      { entity: name },
    );
  }
  return found as TypedRepo<T>;
}

export const merchantAccounts = (ctx: ExecutionContext) =>
  repo<PaymentMerchantAccountRow>(ctx, PaymentEntityName.MerchantAccount);
export const clients = (ctx: ExecutionContext) =>
  repo<PaymentClientRow>(ctx, PaymentEntityName.Client);
export const charges = (ctx: ExecutionContext) =>
  repo<PaymentChargeRow>(ctx, PaymentEntityName.Charge);
export const refunds = (ctx: ExecutionContext) =>
  repo<PaymentRefundRow>(ctx, PaymentEntityName.Refund);
export const disputes = (ctx: ExecutionContext) =>
  repo<PaymentDisputeRow>(ctx, PaymentEntityName.Dispute);
export const providerEvents = (ctx: ExecutionContext) =>
  repo<PaymentProviderEventRow>(ctx, PaymentEntityName.ProviderEvent);

/** Provider id stored on rows saved before the provider call returns. */
export const PENDING_PROVIDER_ID = 'pending:';

export function isPendingProviderId(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PENDING_PROVIDER_ID);
}

/**
 * Write `updates` only while the row still holds `basis` (the values a decision
 * was made from). Returns false when another writer got there first.
 */
export async function writeIfUnchanged<T extends { id: string }>(
  target: TypedRepo<T>,
  id: string,
  basis: Partial<T>,
  updates: Partial<T>,
): Promise<boolean> {
  if (!target.updateWhere) {
    await target.update(id, updates);
    return true;
  }
  return (await target.updateWhere(id, basis, updates)).matched;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids are uuid columns; anything else can never match and must not reach SQL. */
export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * A uuid derived from `name`: the same name always gives the same id, so a
 * retried request writes the same row and sends the provider the same request.
 */
export function stableUuid(name: string): string {
  const bytes = createHash('sha256').update(name).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function findOne<T>(target: TypedRepo<T>, query: Partial<T>): Promise<T | null> {
  const rows = await target.findMany(query, { limit: 1 });
  return rows[0] ?? null;
}
