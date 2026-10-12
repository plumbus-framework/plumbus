// ── Payout capabilities ──
// When sellers' money reaches their bank. Sellers on the full provider dashboard
// manage payouts there; for Express and no-dashboard sellers the app sets the
// schedule (payouts.schedule), may let sellers change it
// (payouts.sellersMayChangeSchedule), and may offer instant payouts
// (payouts.instant). Payout history arrives by webhook.

import { randomUUID } from 'node:crypto';
import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { PaymentEntityName } from '../entities/index.js';
import { payouts, stableUuid } from '../runtime/repos.js';
import {
  ownerMetadata,
  type PaymentsRuntime,
  payoutView,
  requireOwnMerchant,
} from '../runtime/runtime.js';
import type { PaymentMerchantAccountRow } from '../types/records.js';
import { amountSchema, currencySchema, payoutScheduleSchema, payoutViewSchema } from './schemas.js';

const settingsSchema = z.object({
  schedule: payoutScheduleSchema,
  instantAvailable: z.boolean(),
  canChangeSchedule: z.boolean(),
});

export function createPayoutCapabilities(runtime: PaymentsRuntime) {
  const { config, provider } = runtime;
  const external = [`payments:${provider.id}`];
  const managedByApp = (merchant: PaymentMerchantAccountRow) => merchant.dashboard !== 'full';

  const listPayouts = defineCapability({
    name: 'listPayouts',
    kind: 'query',
    domain: 'payments',
    description: "List payouts to the caller's bank account or card, newest first",
    input: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    output: z.object({ payouts: z.array(payoutViewSchema) }),
    access: config.access.sellers,
    effects: { data: [PaymentEntityName.Payout], events: [], external: [], ai: false },
    async handler(ctx, input) {
      const { owner, merchant } = await requireOwnMerchant(ctx, runtime);
      const rows = await payouts(ctx).findMany(
        { tenantId: owner.tenantId, merchantAccountId: merchant.id },
        {
          orderBy: 'createdAt',
          orderDir: 'desc',
          limit: input.limit ?? 50,
          offset: input.offset ?? 0,
        },
      );
      return { payouts: rows.map(payoutView) };
    },
  });

  const retrievePayoutSettings = provider.retrievePayoutSettings?.bind(provider);
  const getPayoutSettings = retrievePayoutSettings
    ? defineCapability({
        name: 'getPayoutSettings',
        kind: 'action',
        domain: 'payments',
        description: "Read the caller's payout schedule and whether instant payouts are possible",
        input: z.object({}),
        output: z.object({ settings: settingsSchema }),
        access: config.access.sellers,
        effects: { data: [], events: [], external, ai: false },
        async handler(ctx) {
          const { merchant } = await requireOwnMerchant(ctx, runtime);
          const settings = await retrievePayoutSettings({ accountId: merchant.providerAccountId });
          return {
            settings: {
              schedule: settings.schedule,
              instantAvailable: config.payouts.instant && settings.instantAvailable,
              canChangeSchedule: config.payouts.sellersMayChangeSchedule && managedByApp(merchant),
            },
          };
        },
      })
    : null;

  const changeSchedule = config.payouts.sellersMayChangeSchedule
    ? provider.updatePayoutSchedule?.bind(provider)
    : undefined;
  const updatePayoutSchedule = changeSchedule
    ? defineCapability({
        name: 'updatePayoutSchedule',
        kind: 'action',
        domain: 'payments',
        description: "Change when the caller's balance is paid out",
        input: z.object({ schedule: payoutScheduleSchema }),
        output: z.object({ settings: settingsSchema }),
        access: config.access.sellers,
        effects: { data: [], events: [], external, ai: false },
        audit: { event: 'payments.payouts.schedule', includeInput: ['schedule'] },
        async handler(ctx, input) {
          const { merchant } = await requireOwnMerchant(ctx, runtime);
          if (!managedByApp(merchant)) {
            throw ctx.errors.conflict(
              'Sellers with the full provider dashboard change their payout schedule there',
              { reason: 'payments_payouts_managed_by_seller' },
            );
          }
          const settings = await changeSchedule({
            accountId: merchant.providerAccountId,
            schedule: input.schedule,
          });
          return {
            settings: {
              schedule: settings.schedule,
              instantAvailable: config.payouts.instant && settings.instantAvailable,
              canChangeSchedule: true,
            },
          };
        },
      })
    : null;

  const createPayout = config.payouts.instant ? provider.createPayout?.bind(provider) : undefined;
  const createInstantPayout = createPayout
    ? defineCapability({
        name: 'createInstantPayout',
        kind: 'action',
        domain: 'payments',
        description:
          "Pay out part of the caller's available balance now, to a debit card (fees apply)",
        input: z.object({
          amount: amountSchema,
          currency: currencySchema,
          requestId: z.string().min(1).max(100).optional(),
        }),
        output: z.object({ payout: payoutViewSchema }),
        access: config.access.sellers,
        effects: { data: [PaymentEntityName.Payout], events: [], external, ai: false },
        audit: {
          event: 'payments.payouts.instant',
          includeInput: ['amount', 'currency', 'requestId'],
        },
        async handler(ctx, input) {
          const { owner, merchant } = await requireOwnMerchant(ctx, runtime);
          const payout = await createPayout({
            accountId: merchant.providerAccountId,
            amount: input.amount,
            currency: input.currency,
            method: 'instant',
            metadata: ownerMetadata(runtime, owner, { plumbus_merchant_account_id: merchant.id }),
            idempotencyKey: `plumbus-payout:${merchant.id}:${input.requestId ?? randomUUID()}`,
          });
          const repo = payouts(ctx);
          const existing = (
            await repo.findMany({
              tenantId: owner.tenantId,
              provider: provider.id,
              providerPayoutId: payout.id,
            })
          )[0];
          const fields = {
            amount: payout.amount,
            currency: payout.currency,
            status: payout.status,
            method: payout.method,
            arrivalDate: payout.arrivalDate,
            failureCode: payout.failureCode,
            syncedAt: ctx.time.now(),
          };
          const row = existing
            ? await repo.update(existing.id, fields)
            : await repo.create({
                ...fields,
                // Same id the payout's webhook would give it, so the two never duplicate.
                id: stableUuid(`plumbus-payout:${provider.id}:${payout.id}`),
                tenantId: owner.tenantId,
                merchantAccountId: merchant.id,
                provider: provider.id,
                providerPayoutId: payout.id,
                livemode: payout.livemode,
              });
          return { payout: payoutView(row) };
        },
      })
    : null;

  return {
    listPayouts,
    ...(getPayoutSettings ? { getPayoutSettings } : {}),
    ...(updatePayoutSchedule ? { updatePayoutSchedule } : {}),
    ...(createInstantPayout ? { createInstantPayout } : {}),
  };
}
