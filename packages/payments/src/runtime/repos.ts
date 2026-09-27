// ── Typed repository accessors ──
// ctx.data is keyed by entity name. These accessors give the payments code
// typed rows without depending on the app's generated registry.

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids are uuid columns; anything else can never match and must not reach SQL. */
export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export async function findOne<T>(target: TypedRepo<T>, query: Partial<T>): Promise<T | null> {
  const rows = await target.findMany(query, { limit: 1 });
  return rows[0] ?? null;
}
