// ── Payment link capabilities ──
// A reusable link a seller shares (a price list, a donation page): anyone with
// it can pay, as often as they like. Each payment becomes a charge (collection
// `link`) when its webhook arrives, and fires the usual charge events. Your fee
// is a fixed amount per payment, computed from the link's items.

import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@plumbus/core';
import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { PaymentEntityName } from '../entities/index.js';
import { checkoutOptions, itemsTotal } from '../runtime/charge-engine.js';
import { links, PENDING_PROVIDER_ID } from '../runtime/repos.js';
import {
  canTakePayments,
  computePlatformFee,
  feeMerchant,
  linkView,
  objectAccount,
  ownerMetadata,
  type PaymentsRuntime,
  requireOwnMerchant,
  sellerRouting,
  withAppMetadata,
} from '../runtime/runtime.js';
import type { PaymentLinkRow, PaymentMerchantAccountRow } from '../types/records.js';
import {
  amountSchema,
  checkoutOptionsSchema,
  currencySchema,
  customAmountSchema,
  linkViewSchema,
  metadataSchema,
} from './schemas.js';

const linkItemInput = z.object({
  name: z.string().min(1).max(250),
  description: z.string().min(1).max(500).optional(),
  unitAmount: amountSchema,
  quantity: z.number().int().min(1).max(10_000).optional(),
  adjustableQuantity: z
    .object({ minimum: z.number().int().min(0), maximum: z.number().int().min(1).max(10_000) })
    .refine((q) => q.minimum <= q.maximum, 'minimum above maximum')
    .optional()
    .describe('Let the client choose how many'),
});

export function createLinkCapabilities(runtime: PaymentsRuntime) {
  const { config, provider } = runtime;
  const external = [`payments:${provider.id}`];

  async function requireOwnLink(
    ctx: ExecutionContext,
    linkId: string,
  ): Promise<{ merchant: PaymentMerchantAccountRow; link: PaymentLinkRow }> {
    const { merchant } = await requireOwnMerchant(ctx, runtime);
    const link = await links(ctx).findById(linkId);
    if (!link || link.merchantAccountId !== merchant.id) {
      throw ctx.errors.notFound('Payment link not found', { reason: 'payments_link_not_found' });
    }
    return { merchant, link };
  }

  const createPaymentLink = defineCapability({
    name: 'createPaymentLink',
    kind: 'action',
    domain: 'payments',
    description:
      "Create a reusable payment link on the caller's seller account; anyone with it can pay",
    input: z.object({
      description: z.string().min(1).max(500),
      currency: currencySchema,
      amount: amountSchema.optional(),
      items: z.array(linkItemInput).min(1).max(20).optional(),
      customAmount: customAmountSchema.optional(),
      options: checkoutOptionsSchema.optional(),
      metadata: metadataSchema.optional(),
    }),
    output: z.object({ link: linkViewSchema }),
    access: config.access.sellers,
    effects: { data: [PaymentEntityName.Link], events: [], external, ai: false },
    audit: { event: 'payments.link.create', includeInput: ['currency', 'amount'] },
    async handler(ctx, input) {
      const { owner, merchant } = await requireOwnMerchant(ctx, runtime);
      if (!canTakePayments(runtime, merchant)) {
        throw ctx.errors.conflict('This payment account cannot take payments yet', {
          reason: 'payments_charges_disabled',
          status: merchant.status,
        });
      }
      if (config.currencies && !config.currencies.includes(input.currency)) {
        throw ctx.errors.validation(`Charges in ${input.currency} are not supported`, {
          reason: 'payments_currency_not_allowed',
        });
      }
      const given = [input.amount, input.items, input.customAmount].filter((v) => v !== undefined);
      if (given.length !== 1) {
        throw ctx.errors.validation('Give exactly one of amount, items, or customAmount', {
          reason: 'payments_amount_required',
        });
      }
      const items = input.items
        ? input.items.map((item) => ({
            name: item.name,
            ...(item.description ? { description: item.description } : {}),
            unitAmount: item.unitAmount,
            quantity: item.quantity ?? 1,
            ...(item.adjustableQuantity ? { adjustableQuantity: item.adjustableQuantity } : {}),
          }))
        : [
            {
              name: input.description,
              unitAmount:
                input.amount ?? input.customAmount?.preset ?? input.customAmount?.minimum ?? 0,
              quantity: 1,
            },
          ];
      const routing = sellerRouting(runtime, merchant);
      const platformFeeAmount = await computePlatformFee(ctx, runtime, {
        amount: input.customAmount ? (input.customAmount.minimum ?? 0) : itemsTotal(items),
        currency: input.currency,
        kind: 'link',
        flow: routing.flow,
        merchant: feeMerchant(merchant),
      });

      const repo = links(ctx);
      const id = randomUUID();
      await repo.create({
        id,
        tenantId: owner.tenantId,
        merchantAccountId: merchant.id,
        provider: provider.id,
        providerLinkId: `${PENDING_PROVIDER_ID}${id}`,
        flow: routing.flow,
        url: null,
        active: false,
        currency: input.currency,
        items,
        customAmount: input.customAmount !== undefined,
        platformFeeAmount,
        description: input.description,
        createdBy: ctx.auth.userId ?? null,
        metadata: input.metadata ?? null,
        livemode: await provider.resolveLivemode(),
      });
      try {
        if (!provider.createPaymentLink) {
          throw ctx.errors.validation(`${provider.displayName} does not support payment links`, {
            reason: 'payments_provider_feature_unsupported',
          });
        }
        const created = await provider.createPaymentLink({
          ...routing,
          reference: id,
          currency: input.currency,
          items,
          ...(input.customAmount ? { customAmount: input.customAmount } : {}),
          platformFeeAmount,
          options: checkoutOptions(runtime, input.options),
          completedUrl: config.urls.linkCompleted,
          metadata: withAppMetadata(
            ownerMetadata(runtime, owner, {
              plumbus_link_id: id,
              plumbus_merchant_account_id: merchant.id,
            }),
            input.metadata,
          ),
        });
        const row = await repo.update(id, {
          providerLinkId: created.id,
          url: created.url,
          active: created.active,
        });
        return { link: linkView(row) };
      } catch (err) {
        await repo.delete(id);
        throw err;
      }
    },
  });

  const listPaymentLinks = defineCapability({
    name: 'listPaymentLinks',
    kind: 'query',
    domain: 'payments',
    description: "List the caller's payment links, newest first",
    input: z.object({
      active: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    output: z.object({ links: z.array(linkViewSchema) }),
    access: config.access.sellers,
    effects: { data: [PaymentEntityName.Link], events: [], external: [], ai: false },
    async handler(ctx, input) {
      const { owner, merchant } = await requireOwnMerchant(ctx, runtime);
      const rows = await links(ctx).findMany(
        {
          tenantId: owner.tenantId,
          merchantAccountId: merchant.id,
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
        {
          orderBy: 'createdAt',
          orderDir: 'desc',
          limit: input.limit ?? 50,
          offset: input.offset ?? 0,
        },
      );
      return { links: rows.map(linkView) };
    },
  });

  const setPaymentLinkActive = defineCapability({
    name: 'setPaymentLinkActive',
    kind: 'action',
    domain: 'payments',
    description: 'Turn a payment link off (nobody can pay through it) or back on',
    input: z.object({ linkId: z.string().uuid(), active: z.boolean() }),
    output: z.object({ link: linkViewSchema }),
    access: config.access.sellers,
    effects: { data: [PaymentEntityName.Link], events: [], external, ai: false },
    audit: { event: 'payments.link.set_active', includeInput: ['linkId', 'active'] },
    async handler(ctx, input) {
      const { merchant, link } = await requireOwnLink(ctx, input.linkId);
      if (!provider.updatePaymentLink) {
        throw ctx.errors.validation(`${provider.displayName} does not support payment links`, {
          reason: 'payments_provider_feature_unsupported',
        });
      }
      const updated = await provider.updatePaymentLink({
        sellerAccountId: objectAccount(sellerRouting(runtime, merchant)),
        linkId: link.providerLinkId,
        active: input.active,
      });
      const row = await links(ctx).update(link.id, { active: updated.active, url: updated.url });
      return { link: linkView(row) };
    },
  });

  return { createPaymentLink, listPaymentLinks, setPaymentLinkActive };
}
