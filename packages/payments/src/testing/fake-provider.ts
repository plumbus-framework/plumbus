// ── Fake payment provider ──
// An in-memory provider for tests: no network, deterministic ids, and helpers
// that move accounts and charges through their lifecycle. Webhook deliveries
// are signed with HMAC-SHA256 so the real route/ingest path runs unchanged.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ChargeStatus,
  DisputeStatus,
  MerchantDashboard,
  PaymentProvider,
  ProviderCharge,
  ProviderDispute,
  ProviderMerchantAccount,
  ProviderRefund,
  ProviderStateChange,
  RefundStatus,
  Responsibility,
  StoredProviderEvent,
  VerifiedProviderEvent,
} from '../types/provider.js';

export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

export interface FakePaymentProviderOptions {
  /** Provider id (default `fake`). */
  id?: string;
  /** Mode the fake credentials are in (default test mode, `false`). */
  livemode?: boolean;
  /** HMAC secret for webhook signatures (default `whsec_fake`). */
  webhookSecret?: string;
}

export interface FakeCall {
  method: string;
  input: unknown;
}

export interface FakeDelivery {
  rawBody: Buffer;
  headers: Record<string, string>;
}

type FakeObjectType = 'account' | 'charge' | 'refund' | 'dispute';

interface FakeChargeRecord extends ProviderCharge {
  accountId: string;
  platformFeeAmount: number;
  amountRefunded: number;
}
interface FakeRefundRecord extends ProviderRefund {
  accountId: string;
  chargeId: string;
}
interface FakeDisputeRecord extends ProviderDispute {
  accountId: string;
  chargeId: string;
}

export interface FakePaymentProvider extends PaymentProvider {
  readonly calls: FakeCall[];
  readonly accounts: Map<string, ProviderMerchantAccount>;
  readonly charges: Map<string, FakeChargeRecord>;
  readonly refunds: Map<string, FakeRefundRecord>;
  readonly disputes: Map<string, FakeDisputeRecord>;
  /** Mark onboarding complete: payments and payouts on, nothing due. */
  completeOnboarding(accountId: string): ProviderMerchantAccount;
  /** Put a requirement past due and switch payments off. */
  restrictAccount(accountId: string, requirement: string): ProviderMerchantAccount;
  closeAccount(accountId: string): ProviderMerchantAccount;
  setChargeStatus(chargeId: string, status: ChargeStatus): FakeChargeRecord;
  payCharge(chargeId: string): FakeChargeRecord;
  settleRefund(refundId: string, status: RefundStatus, failureReason?: string): FakeRefundRecord;
  openDispute(chargeId: string, options?: { amount?: number; reason?: string }): FakeDisputeRecord;
  setDisputeStatus(disputeId: string, status: DisputeStatus): FakeDisputeRecord;
  /** Make the next call to `method` throw `error`. */
  failNext(method: string, error: Error): void;
  /** A signed webhook delivery about one object, e.g. `event('charge', chargeId)`. */
  event(
    objectType: FakeObjectType,
    objectId: string,
    options?: { type?: string; livemode?: boolean; eventId?: string },
  ): FakeDelivery;
}

const DEFAULT_RESPONSIBILITIES: Record<
  MerchantDashboard,
  { fees: Responsibility; losses: Responsibility }
> = {
  full: { fees: 'provider', losses: 'provider' },
  express: { fees: 'platform', losses: 'platform' },
  none: { fees: 'provider', losses: 'provider' },
};

export function createFakePaymentProvider(
  options: FakePaymentProviderOptions = {},
): FakePaymentProvider {
  const id = options.id ?? 'fake';
  const livemode = options.livemode ?? false;
  const secret = options.webhookSecret ?? 'whsec_fake';
  const calls: FakeCall[] = [];
  const accounts = new Map<string, ProviderMerchantAccount>();
  const charges = new Map<string, FakeChargeRecord>();
  const refunds = new Map<string, FakeRefundRecord>();
  const disputes = new Map<string, FakeDisputeRecord>();
  const failures = new Map<string, Error>();
  const idempotency = new Map<string, unknown>();
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_${++counter}`;

  function record(method: string, input: unknown): void {
    calls.push({ method, input });
    const failure = failures.get(method);
    if (failure) {
      failures.delete(method);
      throw failure;
    }
  }

  function once<T>(key: string, create: () => T): T {
    if (idempotency.has(key)) return idempotency.get(key) as T;
    const value = create();
    idempotency.set(key, value);
    return value;
  }

  function must<T>(map: Map<string, T>, key: string, what: string): T {
    const value = map.get(key);
    if (!value) throw new Error(`fake provider: unknown ${what} ${key}`);
    return value;
  }

  function sign(body: string): string {
    return createHmac('sha256', secret).update(body).digest('hex');
  }

  function chargeByPayment(paymentId: string): FakeChargeRecord | undefined {
    return [...charges.values()].find((c) => c.paymentId === paymentId);
  }

  const provider: FakePaymentProvider = {
    id,
    displayName: 'Fake payments',
    calls,
    accounts,
    charges,
    refunds,
    disputes,

    defaultResponsibilities(dashboard) {
      return DEFAULT_RESPONSIBILITIES[dashboard];
    },
    validateConfig() {
      return [];
    },
    async resolveLivemode() {
      return livemode;
    },
    isRelevantEvent(event) {
      return ['account.', 'charge.', 'refund.', 'dispute.'].some((p) => event.type.startsWith(p));
    },

    async createMerchantAccount(input) {
      record('createMerchantAccount', input);
      return once(input.idempotencyKey, () => {
        const account: ProviderMerchantAccount = {
          id: nextId('acct_fake'),
          dashboard: input.dashboard,
          feesCollector: input.feesCollector,
          lossesCollector: input.lossesCollector,
          country: input.country,
          defaultCurrency: input.defaultCurrency ?? null,
          chargesEnabled: false,
          payoutsEnabled: false,
          requirementsDue: ['Business details', 'Bank account'],
          requirementsPastDue: [],
          disabledReason: null,
          closed: false,
          livemode,
        };
        accounts.set(account.id, account);
        return { ...account };
      });
    },
    async retrieveMerchantAccount(accountId) {
      record('retrieveMerchantAccount', { accountId });
      return { ...must(accounts, accountId, 'account') };
    },
    async createOnboardingLink(input) {
      record('createOnboardingLink', input);
      must(accounts, input.accountId, 'account');
      return {
        url: `https://connect.fake.test/onboard/${input.accountId}`,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      };
    },
    async createMerchantSession(input) {
      record('createMerchantSession', input);
      must(accounts, input.accountId, 'account');
      return {
        clientSecret: `${input.accountId}_secret_${++counter}`,
        expiresAt: new Date(Date.now() + 30 * 60_000),
        publishableKey: 'pk_fake',
      };
    },
    async createDashboardLink(input) {
      record('createDashboardLink', input);
      must(accounts, input.accountId, 'account');
      return { url: `https://dashboard.fake.test/${input.dashboard}/${input.accountId}` };
    },
    async createClient(input) {
      record('createClient', input);
      return once(input.idempotencyKey, () => ({ clientId: nextId('cus_fake') }));
    },
    async createCharge(input) {
      record('createCharge', input);
      const account = must(accounts, input.accountId, 'account');
      if (!account.chargesEnabled) throw new Error('fake provider: account cannot take charges');
      return once(input.idempotencyKey, () => {
        const chargeId = nextId('cs_fake');
        const charge: FakeChargeRecord = {
          id: chargeId,
          accountId: input.accountId,
          reference: input.reference,
          paymentId: null,
          status: 'open',
          amount: input.amount,
          currency: input.currency,
          platformFeeAmount: input.platformFeeAmount,
          amountRefunded: 0,
          url: `https://pay.fake.test/${chargeId}`,
          expiresAt: input.expiresAt,
          paidAt: null,
          clientEmail: input.clientEmail ?? null,
          livemode,
        };
        charges.set(chargeId, charge);
        return stripAccount(charge);
      });
    },
    async createRefund(input) {
      record('createRefund', input);
      return once(input.idempotencyKey, () => {
        const charge = chargeByPayment(input.paymentId);
        if (!charge) throw new Error(`fake provider: unknown payment ${input.paymentId}`);
        const refund: FakeRefundRecord = {
          id: nextId('re_fake'),
          accountId: input.accountId,
          chargeId: charge.id,
          reference: input.reference,
          paymentId: input.paymentId,
          amount: input.amount ?? charge.amount - charge.amountRefunded,
          currency: charge.currency,
          status: 'pending',
          reason: input.reason ?? null,
          failureReason: null,
        };
        refunds.set(refund.id, refund);
        return stripRefund(refund);
      });
    },

    async verifyWebhook({ rawBody, headers }) {
      const header = headers[FAKE_SIGNATURE_HEADER];
      const given = Array.isArray(header) ? header[0] : header;
      const expected = sign(rawBody.toString('utf8'));
      if (
        !given ||
        given.length !== expected.length ||
        !timingSafeEqual(Buffer.from(given), Buffer.from(expected))
      ) {
        throw new Error('fake provider: bad signature');
      }
      const body = JSON.parse(rawBody.toString('utf8')) as {
        id: string;
        type: string;
        livemode: boolean;
        created: string;
        account: string | null;
        object: { id: string; type: string };
      };
      const event: VerifiedProviderEvent = {
        eventId: body.id,
        type: body.type,
        format: 'thin',
        livemode: body.livemode,
        occurredAt: new Date(body.created),
        accountId: body.account,
        objectId: body.object.id,
        objectType: body.object.type,
        payload: body,
      };
      return event;
    },

    async resolveEvent(event: StoredProviderEvent) {
      record('resolveEvent', event);
      const objectId = event.objectId ?? '';
      const changes: ProviderStateChange[] = [];
      switch (event.objectType) {
        case 'account':
          changes.push({ kind: 'merchant', account: { ...must(accounts, objectId, 'account') } });
          break;
        case 'charge': {
          const charge = must(charges, objectId, 'charge');
          changes.push({
            kind: 'charge',
            accountId: charge.accountId,
            charge: stripAccount(charge),
          });
          break;
        }
        case 'refund': {
          const refund = must(refunds, objectId, 'refund');
          const charge = must(charges, refund.chargeId, 'charge');
          // The charge first, like real providers: it carries the payment id refunds match on.
          changes.push({
            kind: 'charge',
            accountId: charge.accountId,
            charge: stripAccount(charge),
          });
          changes.push({
            kind: 'refund',
            accountId: refund.accountId,
            chargeReference: charge.reference,
            refund: stripRefund(refund),
          });
          break;
        }
        case 'dispute': {
          const dispute = must(disputes, objectId, 'dispute');
          const charge = must(charges, dispute.chargeId, 'charge');
          const { accountId, chargeId: _chargeId, ...rest } = dispute;
          changes.push({
            kind: 'dispute',
            accountId,
            chargeReference: charge.reference,
            dispute: rest,
          });
          break;
        }
      }
      return changes;
    },

    completeOnboarding(accountId) {
      const account = must(accounts, accountId, 'account');
      Object.assign(account, {
        chargesEnabled: true,
        payoutsEnabled: true,
        requirementsDue: [],
        requirementsPastDue: [],
        disabledReason: null,
      });
      return { ...account };
    },
    restrictAccount(accountId, requirement) {
      const account = must(accounts, accountId, 'account');
      Object.assign(account, {
        chargesEnabled: false,
        requirementsDue: [requirement],
        requirementsPastDue: [requirement],
        disabledReason: 'requirements_past_due',
      });
      return { ...account };
    },
    closeAccount(accountId) {
      const account = must(accounts, accountId, 'account');
      Object.assign(account, { closed: true, chargesEnabled: false, payoutsEnabled: false });
      return { ...account };
    },
    setChargeStatus(chargeId, status) {
      const charge = must(charges, chargeId, 'charge');
      charge.status = status;
      if (status !== 'open') charge.url = null;
      return charge;
    },
    payCharge(chargeId) {
      const charge = must(charges, chargeId, 'charge');
      charge.status = 'paid';
      charge.paymentId = charge.paymentId ?? nextId('pi_fake');
      charge.paidAt = new Date();
      charge.url = null;
      return charge;
    },
    settleRefund(refundId, status, failureReason) {
      const refund = must(refunds, refundId, 'refund');
      const previous = refund.status;
      refund.status = status;
      refund.failureReason = failureReason ?? null;
      if (status === 'succeeded' && previous !== 'succeeded') {
        const charge = must(charges, refund.chargeId, 'charge');
        charge.amountRefunded += refund.amount;
      }
      return refund;
    },
    openDispute(chargeId, disputeOptions = {}) {
      const charge = must(charges, chargeId, 'charge');
      if (!charge.paymentId) throw new Error('fake provider: dispute needs a paid charge');
      const dispute: FakeDisputeRecord = {
        id: nextId('dp_fake'),
        accountId: charge.accountId,
        chargeId,
        paymentId: charge.paymentId,
        amount: disputeOptions.amount ?? charge.amount,
        currency: charge.currency,
        status: 'needs_response',
        providerStatus: 'needs_response',
        reason: disputeOptions.reason ?? 'fraudulent',
        evidenceDueBy: new Date(Date.now() + 7 * 24 * 3_600_000),
      };
      disputes.set(dispute.id, dispute);
      return dispute;
    },
    setDisputeStatus(disputeId, status) {
      const dispute = must(disputes, disputeId, 'dispute');
      dispute.status = status;
      dispute.providerStatus = status;
      return dispute;
    },
    failNext(method, error) {
      failures.set(method, error);
    },
    event(objectType, objectId, eventOptions = {}) {
      const accountId =
        objectType === 'account'
          ? objectId
          : objectType === 'charge'
            ? must(charges, objectId, 'charge').accountId
            : objectType === 'refund'
              ? must(refunds, objectId, 'refund').accountId
              : must(disputes, objectId, 'dispute').accountId;
      const body = JSON.stringify({
        id: eventOptions.eventId ?? nextId('evt_fake'),
        type: eventOptions.type ?? `${objectType}.updated`,
        livemode: eventOptions.livemode ?? livemode,
        created: new Date().toISOString(),
        account: accountId,
        object: { id: objectId, type: objectType },
      });
      return {
        rawBody: Buffer.from(body),
        headers: { 'content-type': 'application/json', [FAKE_SIGNATURE_HEADER]: sign(body) },
      };
    },
  };
  return provider;
}

function stripAccount(charge: FakeChargeRecord): ProviderCharge {
  const { accountId: _accountId, ...rest } = charge;
  return { ...rest };
}

function stripRefund(refund: FakeRefundRecord): ProviderRefund {
  const { accountId: _accountId, chargeId: _chargeId, ...rest } = refund;
  return { ...rest };
}
