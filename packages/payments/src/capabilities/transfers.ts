// ── Transfer capabilities ──
// Sellers see the money the platform sent them from its own balance (split
// payments, delayed payouts). Transfers themselves are made server-side with
// `payments.platform.transferToSeller(ctx, …)`. Created with `transfers.enabled`.

import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { PaymentEntityName } from '../entities/index.js';
import { transfers } from '../runtime/repos.js';
import { type PaymentsRuntime, requireOwnMerchant, transferView } from '../runtime/runtime.js';
import { transferViewSchema } from './schemas.js';

export function createTransferCapabilities(runtime: PaymentsRuntime) {
  const { config } = runtime;

  const listTransfers = defineCapability({
    name: 'listTransfers',
    kind: 'query',
    domain: 'payments',
    description: 'List money the platform transferred to the caller, newest first',
    input: z.object({
      chargeId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    output: z.object({ transfers: z.array(transferViewSchema) }),
    access: config.access.sellers,
    effects: { data: [PaymentEntityName.Transfer], events: [], external: [], ai: false },
    async handler(ctx, input) {
      const { owner, merchant } = await requireOwnMerchant(ctx, runtime);
      const rows = await transfers(ctx).findMany(
        {
          tenantId: owner.tenantId,
          merchantAccountId: merchant.id,
          ...(input.chargeId ? { chargeId: input.chargeId } : {}),
        },
        {
          orderBy: 'createdAt',
          orderDir: 'desc',
          limit: input.limit ?? 50,
          offset: input.offset ?? 0,
        },
      );
      return { transfers: rows.map(transferView) };
    },
  });

  return { listTransfers };
}
