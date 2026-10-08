// ── Dispute capabilities ──
// Disputes arrive by webhook (payments.dispute.* events). Sellers read theirs
// and answer them: submit evidence before `evidenceDueBy`, or accept the loss.
// Files (receipts, photos) are uploaded in the provider's own dispute screens or
// embedded components; this API carries the text evidence.

import type { ExecutionContext } from '@plumbus/core';
import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { PaymentEntityName } from '../entities/index.js';
import { disputes } from '../runtime/repos.js';
import {
  disputeView,
  objectAccount,
  type PaymentsRuntime,
  requireOwnMerchant,
  sellerRouting,
} from '../runtime/runtime.js';
import type { PaymentDisputeRow, PaymentMerchantAccountRow } from '../types/records.js';
import { disputeStatusSchema, disputeViewSchema } from './schemas.js';

const text = (max: number) => z.string().min(1).max(max).optional();

export function createDisputeCapabilities(runtime: PaymentsRuntime) {
  const { config, provider } = runtime;
  const external = [`payments:${provider.id}`];

  async function requireOwnDispute(
    ctx: ExecutionContext,
    disputeId: string,
  ): Promise<{ merchant: PaymentMerchantAccountRow; dispute: PaymentDisputeRow }> {
    const { merchant } = await requireOwnMerchant(ctx, runtime);
    const dispute = await disputes(ctx).findById(disputeId);
    if (!dispute || dispute.merchantAccountId !== merchant.id) {
      throw ctx.errors.notFound('Dispute not found', { reason: 'payments_dispute_not_found' });
    }
    return { merchant, dispute };
  }

  function requireOpen(ctx: ExecutionContext, dispute: PaymentDisputeRow) {
    if (dispute.status !== 'needs_response' || dispute.evidenceSubmitted) {
      throw ctx.errors.conflict('This dispute no longer takes a response', {
        reason: 'payments_dispute_closed',
        status: dispute.status,
      });
    }
  }

  async function write(
    ctx: ExecutionContext,
    dispute: PaymentDisputeRow,
    fresh: {
      status: PaymentDisputeRow['status'];
      providerStatus: string;
      evidenceSubmitted: boolean;
    },
  ) {
    return disputes(ctx).update(dispute.id, {
      status: fresh.status,
      providerStatus: fresh.providerStatus,
      evidenceSubmitted: fresh.evidenceSubmitted,
      syncedAt: ctx.time.now(),
    });
  }

  const listDisputes = defineCapability({
    name: 'listDisputes',
    kind: 'query',
    domain: 'payments',
    description: "List disputes on the caller's charges, newest first",
    input: z.object({
      status: disputeStatusSchema.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    output: z.object({ disputes: z.array(disputeViewSchema) }),
    access: config.access.disputes,
    effects: { data: [PaymentEntityName.Dispute], events: [], external: [], ai: false },
    async handler(ctx, input) {
      const { owner, merchant } = await requireOwnMerchant(ctx, runtime);
      const rows = await disputes(ctx).findMany(
        {
          tenantId: owner.tenantId,
          merchantAccountId: merchant.id,
          ...(input.status ? { status: input.status } : {}),
        },
        {
          orderBy: 'createdAt',
          orderDir: 'desc',
          limit: input.limit ?? 50,
          offset: input.offset ?? 0,
        },
      );
      return { disputes: rows.map(disputeView) };
    },
  });

  const updateDispute = provider.updateDispute?.bind(provider);
  const respondToDispute = updateDispute
    ? defineCapability({
        name: 'respondToDispute',
        kind: 'action',
        domain: 'payments',
        description: 'Save evidence for a dispute, and submit it (submitting is final)',
        input: z.object({
          disputeId: z.string().uuid(),
          evidence: z.object({
            productDescription: text(20_000),
            customerName: text(500),
            customerEmail: z.string().email().optional(),
            serviceDate: text(100),
            refundPolicy: text(20_000),
            cancellationPolicy: text(20_000),
            uncategorizedText: text(20_000),
          }),
          submit: z.boolean().describe('true: send it to the bank now; it cannot be changed after'),
        }),
        output: z.object({ dispute: disputeViewSchema }),
        access: config.access.disputes,
        effects: { data: [PaymentEntityName.Dispute], events: [], external, ai: false },
        audit: { event: 'payments.dispute.respond', includeInput: ['disputeId', 'submit'] },
        async handler(ctx, input) {
          const { merchant, dispute } = await requireOwnDispute(ctx, input.disputeId);
          requireOpen(ctx, dispute);
          const fresh = await updateDispute({
            sellerAccountId: objectAccount(sellerRouting(runtime, merchant)),
            disputeId: dispute.providerDisputeId,
            evidence: input.evidence,
            submit: input.submit,
          });
          return { dispute: disputeView(await write(ctx, dispute, fresh)) };
        },
      })
    : null;

  const acceptAtProvider = provider.acceptDispute?.bind(provider);
  const acceptDispute = acceptAtProvider
    ? defineCapability({
        name: 'acceptDispute',
        kind: 'action',
        domain: 'payments',
        description: 'Accept a dispute: the client keeps the money and the dispute closes as lost',
        input: z.object({ disputeId: z.string().uuid() }),
        output: z.object({ dispute: disputeViewSchema }),
        access: config.access.disputes,
        effects: { data: [PaymentEntityName.Dispute], events: [], external, ai: false },
        audit: { event: 'payments.dispute.accept', includeInput: ['disputeId'] },
        async handler(ctx, input) {
          const { merchant, dispute } = await requireOwnDispute(ctx, input.disputeId);
          requireOpen(ctx, dispute);
          const fresh = await acceptAtProvider({
            sellerAccountId: objectAccount(sellerRouting(runtime, merchant)),
            disputeId: dispute.providerDisputeId,
          });
          return { dispute: disputeView(await write(ctx, dispute, fresh)) };
        },
      })
    : null;

  return {
    listDisputes,
    ...(respondToDispute ? { respondToDispute } : {}),
    ...(acceptDispute ? { acceptDispute } : {}),
  };
}
