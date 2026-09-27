// ── Row shapes of the payments entities ──
// What `ctx.data.Payment*` returns. Exported so app code that reads payments
// through ctx.data gets typed rows.

import type {
  ChargeStatus,
  DisputeStatus,
  MerchantDashboard,
  RefundStatus,
  Responsibility,
} from './provider.js';
import type { SellerOwner } from './config.js';

export type MerchantAccountStatus = 'onboarding' | 'active' | 'restricted' | 'closed';

interface Timestamps {
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PaymentMerchantAccountRow extends Timestamps {
  id: string;
  tenantId: string;
  ownerType: SellerOwner;
  ownerId: string;
  provider: string;
  providerAccountId: string;
  dashboard: MerchantDashboard;
  feesCollector: Responsibility;
  lossesCollector: Responsibility;
  country: string | null;
  defaultCurrency: string | null;
  status: MerchantAccountStatus;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue: string[] | null;
  requirementsPastDue: string[] | null;
  disabledReason: string | null;
  livemode: boolean;
  syncedAt: Date | null;
}

export interface PaymentClientRow extends Timestamps {
  id: string;
  tenantId?: string;
  merchantAccountId: string;
  provider: string;
  providerClientId: string;
  reference: string | null;
  userId: string | null;
  email: string | null;
  name: string | null;
}

export interface PaymentChargeRow extends Timestamps {
  id: string;
  tenantId?: string;
  merchantAccountId: string;
  clientId: string | null;
  provider: string;
  providerChargeId: string;
  providerPaymentId: string | null;
  requestId: string | null;
  status: ChargeStatus;
  amount: number;
  currency: string;
  platformFeeAmount: number;
  amountRefunded: number;
  description: string;
  url: string | null;
  expiresAt: Date | null;
  paidAt: Date | null;
  clientEmail: string | null;
  createdBy: string | null;
  metadata: Record<string, string> | null;
  livemode: boolean;
  syncedAt: Date | null;
}

export interface PaymentRefundRow extends Timestamps {
  id: string;
  tenantId?: string;
  chargeId: string;
  merchantAccountId: string;
  provider: string;
  providerRefundId: string;
  requestId: string | null;
  amount: number;
  currency: string;
  status: RefundStatus;
  reason: string | null;
  failureReason: string | null;
  requestedBy: string | null;
  syncedAt: Date | null;
}

export interface PaymentDisputeRow extends Timestamps {
  id: string;
  tenantId?: string;
  chargeId: string | null;
  merchantAccountId: string;
  provider: string;
  providerDisputeId: string;
  providerPaymentId: string;
  amount: number;
  currency: string;
  status: DisputeStatus;
  providerStatus: string;
  reason: string | null;
  evidenceDueBy: Date | null;
  syncedAt: Date | null;
}

export type ProviderEventStatus = 'received' | 'processed' | 'ignored' | 'failed';

export interface PaymentProviderEventRow extends Timestamps {
  id: string;
  tenantId: string | null;
  provider: string;
  providerEventId: string;
  type: string;
  format: 'snapshot' | 'thin';
  livemode: boolean;
  providerAccountId: string | null;
  merchantAccountId: string | null;
  objectId: string | null;
  objectType: string | null;
  status: ProviderEventStatus;
  ignoredReason: string | null;
  error: string | null;
  occurredAt: Date;
  receivedAt: Date;
  processedAt: Date | null;
  payload: unknown;
}
