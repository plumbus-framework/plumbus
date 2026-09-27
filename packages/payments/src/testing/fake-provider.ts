// ── Fake payment provider ──
// An in-memory provider for tests: no network, deterministic ids, and helpers
// that move accounts, charges, subscriptions, and payouts through their
// lifecycle. Webhook deliveries are signed with HMAC-SHA256 so the real
// route/ingest/worker path runs unchanged. It enforces the rules a real
// provider would (sellers must be able to take payments, refunds cannot exceed
// the charge, an idempotency key repeats its first answer).

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  BillingInterval,
  CatalogInput,
  ChargeItem,
  ChargeStatus,
  CustomAmount,
  DisputeStatus,
  MerchantDashboard,
  PaymentProvider,
  PayoutSchedule,
  PayoutStatus,
  ProviderCharge,
  ProviderDispute,
  ProviderInvoice,
  ProviderMerchantAccount,
  ProviderPaymentMethod,
  ProviderPayout,
  ProviderRefund,
  ProviderStateChange,
  ProviderSubscription,
  ProviderSubscriptionItem,
  ProviderTransfer,
  RefundStatus,
  Responsibility,
  StoredProviderEvent,
  SubscriptionItemInput,
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

export type FakeObjectType =
  | 'account'
  | 'charge'
  | 'refund'
  | 'dispute'
  | 'payment_method'
  | 'subscription'
  | 'subscription_checkout'
  | 'setup'
  | 'invoice'
  | 'transfer'
  | 'payout'
  | 'entitlements';

export interface FakeAccount extends ProviderMerchantAccount {
  requested: { cardPayments: boolean; transfers: boolean };
  payoutSchedule: PayoutSchedule;
  metadata: Record<string, string>;
}

export interface FakeChargeRecord extends ProviderCharge {
  /** Where the object lives: a seller account (direct), or null for the platform. */
  accountId: string | null;
  /** The seller paid (destination charges), or the direct seller. */
  sellerAccountId: string | null;
  kind: 'checkout' | 'invoice' | 'payment';
  items: ChargeItem[];
  customAmount: CustomAmount | null;
  capture: 'automatic' | 'manual';
  saveMethod: boolean;
  platformFeeAmount: number;
  amountRefunded: number;
  metadata: Record<string, string>;
}

export interface FakeRefundRecord extends ProviderRefund {
  accountId: string | null;
  chargeId: string;
}

export interface FakeDisputeRecord extends ProviderDispute {
  accountId: string | null;
  chargeId: string;
}

export interface FakeCustomer {
  id: string;
  accountId: string | null;
  email: string | null;
  name: string | null;
  metadata: Record<string, string>;
}

export interface FakeMethod extends ProviderPaymentMethod {
  accountId: string | null;
  detached: boolean;
}

export interface FakeSubscriptionCheckout {
  id: string;
  accountId: string | null;
  reference: string;
  customerId: string;
  currency: string;
  items: SubscriptionItemInput[];
  trialDays: number | null;
  applicationFeePercent: number | null;
  status: 'open' | 'complete' | 'expired';
  subscriptionId: string | null;
  url: string;
  metadata: Record<string, string>;
}

export interface FakeSetupSession {
  id: string;
  accountId: string | null;
  customerId: string;
  reference: string;
  status: 'open' | 'complete' | 'expired';
  methodId: string | null;
  url: string;
}

export interface FakeSubscriptionRecord extends ProviderSubscription {
  accountId: string | null;
  metadata: Record<string, string>;
}

export interface FakeInvoiceRecord extends ProviderInvoice {
  accountId: string | null;
}

export interface FakeLink {
  id: string;
  accountId: string | null;
  sellerAccountId: string | null;
  reference: string;
  currency: string;
  items: ChargeItem[];
  customAmount: CustomAmount | null;
  platformFeeAmount: number;
  active: boolean;
  url: string;
}

export interface FakePrice {
  id: string;
  lookupKey: string;
  name: string;
  unitAmount: number | null;
  currency: string;
  interval: BillingInterval;
  intervalCount: number;
  metered: boolean;
  /** Plan features this price grants (catalog plans). */
  features: string[];
}

export interface FakePaymentProvider extends PaymentProvider {
  readonly calls: FakeCall[];
  readonly accounts: Map<string, FakeAccount>;
  readonly customers: Map<string, FakeCustomer>;
  readonly methods: Map<string, FakeMethod>;
  readonly charges: Map<string, FakeChargeRecord>;
  readonly refunds: Map<string, FakeRefundRecord>;
  readonly disputes: Map<string, FakeDisputeRecord>;
  readonly subscriptions: Map<string, FakeSubscriptionRecord>;
  readonly subscriptionCheckouts: Map<string, FakeSubscriptionCheckout>;
  readonly setupSessions: Map<string, FakeSetupSession>;
  readonly invoices: Map<string, FakeInvoiceRecord>;
  readonly links: Map<string, FakeLink>;
  readonly transfers: Map<string, ProviderTransfer>;
  readonly payouts: Map<string, ProviderPayout & { accountId: string }>;
  readonly prices: Map<string, FakePrice>;
  readonly entitlementsByCustomer: Map<string, string[]>;
  readonly usage: Array<{
    customerId: string;
    eventName: string;
    value: number;
    identifier: string;
  }>;
  /** Mark onboarding complete: the requested abilities and payouts on, nothing due. */
  completeOnboarding(accountId: string): ProviderMerchantAccount;
  /** Put a requirement past due and switch payments off. */
  restrictAccount(accountId: string, requirement: string): ProviderMerchantAccount;
  closeAccount(accountId: string): ProviderMerchantAccount;
  setChargeStatus(chargeId: string, status: ChargeStatus): FakeChargeRecord;
  /**
   * The client pays a checkout page or invoice: `paid`, or `authorized` for manual
   * capture. `saveMethod` pages keep the card on the customer.
   */
  payCharge(
    chargeId: string,
    options?: { amount?: number; discount?: number; tax?: number },
  ): FakeChargeRecord;
  /** How the next saved-method charge ends (default `paid`). */
  setSavedMethodOutcome(outcome: 'paid' | 'requires_action' | 'failed'): void;
  settleRefund(refundId: string, status: RefundStatus, failureReason?: string): FakeRefundRecord;
  openDispute(chargeId: string, options?: { amount?: number; reason?: string }): FakeDisputeRecord;
  setDisputeStatus(disputeId: string, status: DisputeStatus): FakeDisputeRecord;
  /** The client finishes a save-a-payment-method page: a card is attached. */
  completeSetup(setupId: string, card?: { brand?: string; last4?: string }): FakeMethod;
  /** The client finishes a subscription checkout: the subscription starts, its first invoice is paid. */
  completeSubscriptionCheckout(checkoutId: string): FakeSubscriptionRecord;
  expireSubscriptionCheckout(checkoutId: string): FakeSubscriptionCheckout;
  /** A new period: a renewal invoice, paid or failed (failed makes the subscription past due). */
  renewSubscription(subscriptionId: string, options?: { paid?: boolean }): FakeInvoiceRecord;
  /** Someone pays through a payment link. */
  payLink(
    linkId: string,
    options?: { quantity?: number; amount?: number; email?: string },
  ): FakeChargeRecord;
  /** A payout to a seller's bank (standard). */
  payoutSeller(
    accountId: string,
    options: { amount: number; currency?: string; status?: PayoutStatus },
  ): ProviderPayout;
  setPayoutStatus(payoutId: string, status: PayoutStatus): ProviderPayout;
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

const DAY = 24 * 3_600_000;
const INTERVAL_MS: Record<BillingInterval, number> = {
  day: DAY,
  week: 7 * DAY,
  month: 30 * DAY,
  year: 365 * DAY,
};

class FakeProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(`fake provider: ${message}`);
  }
}

export function createFakePaymentProvider(
  options: FakePaymentProviderOptions = {},
): FakePaymentProvider {
  const id = options.id ?? 'fake';
  const livemode = options.livemode ?? false;
  const secret = options.webhookSecret ?? 'whsec_fake';
  const calls: FakeCall[] = [];
  const accounts = new Map<string, FakeAccount>();
  const customers = new Map<string, FakeCustomer>();
  const methods = new Map<string, FakeMethod>();
  const charges = new Map<string, FakeChargeRecord>();
  const refunds = new Map<string, FakeRefundRecord>();
  const disputes = new Map<string, FakeDisputeRecord>();
  const subscriptions = new Map<string, FakeSubscriptionRecord>();
  const subscriptionCheckouts = new Map<string, FakeSubscriptionCheckout>();
  const setupSessions = new Map<string, FakeSetupSession>();
  const invoices = new Map<string, FakeInvoiceRecord>();
  const links = new Map<string, FakeLink>();
  const transfers = new Map<string, ProviderTransfer>();
  const payouts = new Map<string, ProviderPayout & { accountId: string }>();
  const transferMetadata = new Map<string, Record<string, string>>();
  const prices = new Map<string, FakePrice>();
  const entitlementsByCustomer = new Map<string, string[]>();
  const usage: FakePaymentProvider['usage'] = [];
  const failures = new Map<string, Error>();
  const idempotency = new Map<string, unknown>();
  let savedMethodOutcome: 'paid' | 'requires_action' | 'failed' = 'paid';
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_${++counter}`;
  const now = () => new Date();

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
    if (!value) throw new FakeProviderError(`unknown ${what} ${key}`, 'resource_missing');
    return value;
  }

  function sign(body: string): string {
    return createHmac('sha256', secret).update(body).digest('hex');
  }

  /** Where an object for this routing lives: the seller for direct charges, else the platform. */
  function home(routing: { flow: string; sellerAccountId: string | null }): string | null {
    return routing.flow === 'direct' ? routing.sellerAccountId : null;
  }

  function requireCanBePaid(routing: { flow: string; sellerAccountId: string | null }) {
    if (routing.flow === 'platform') return;
    const account = must(accounts, routing.sellerAccountId ?? '', 'account');
    if (routing.flow === 'direct' && !account.chargesEnabled) {
      throw new FakeProviderError('account cannot take charges', 'account_invalid');
    }
    if (routing.flow === 'destination' && !account.transfersEnabled) {
      throw new FakeProviderError('destination cannot receive transfers', 'account_invalid');
    }
  }

  function customerOn(customerId: string | undefined, accountId: string | null): void {
    if (!customerId) return;
    const customer = must(customers, customerId, 'customer');
    if (customer.accountId !== accountId) {
      throw new FakeProviderError(
        `customer ${customerId} is not on this account`,
        'resource_missing',
      );
    }
  }

  const subtotal = (items: ChargeItem[]) =>
    items.reduce((sum, item) => sum + item.unitAmount * item.quantity, 0);

  function chargeView(charge: FakeChargeRecord): ProviderCharge {
    const {
      accountId: _a,
      sellerAccountId: _s,
      kind: _k,
      items: _i,
      customAmount: _c,
      capture: _capture,
      saveMethod: _save,
      metadata: _m,
      ...rest
    } = charge;
    return { ...rest };
  }

  function refundView(refund: FakeRefundRecord): ProviderRefund {
    const { accountId: _accountId, chargeId: _chargeId, ...rest } = refund;
    return { ...rest };
  }

  function methodView(method: FakeMethod): ProviderPaymentMethod {
    const { accountId: _accountId, detached, ...rest } = method;
    // Like Stripe, a detached method no longer names its customer.
    return { ...rest, customerId: detached ? null : rest.customerId };
  }

  function subscriptionView(sub: FakeSubscriptionRecord): ProviderSubscription {
    const { accountId: _accountId, metadata: _metadata, ...rest } = sub;
    return { ...rest, items: sub.items.map((item) => ({ ...item })) };
  }

  function invoiceView(invoice: FakeInvoiceRecord): ProviderInvoice {
    const { accountId: _accountId, ...rest } = invoice;
    return { ...rest };
  }

  function accountView(account: FakeAccount): ProviderMerchantAccount {
    const {
      requested: _requested,
      payoutSchedule: _schedule,
      metadata: _metadata,
      ...rest
    } = account;
    return {
      ...rest,
      requirementsDue: [...rest.requirementsDue],
      requirementsPastDue: [...rest.requirementsPastDue],
    };
  }

  function newCharge(
    fields: Partial<FakeChargeRecord> &
      Pick<FakeChargeRecord, 'accountId' | 'sellerAccountId' | 'kind' | 'items' | 'currency'>,
  ): FakeChargeRecord {
    const amount = fields.customAmount
      ? (fields.customAmount.preset ?? fields.customAmount.minimum ?? 0)
      : subtotal(fields.items);
    const prefix =
      fields.kind === 'checkout' ? 'cs_fake' : fields.kind === 'invoice' ? 'in_fake' : 'pi_fake';
    const charge: FakeChargeRecord = {
      id: nextId(prefix),
      reference: null,
      paymentId: null,
      linkId: null,
      status: 'open',
      amountSubtotal: amount,
      amountTotal: amount,
      amountDiscount: 0,
      amountTax: 0,
      platformFeeAmount: 0,
      amountRefunded: 0,
      amountCapturable: null,
      captureBefore: null,
      url: null,
      clientSecret: null,
      expiresAt: null,
      paidAt: null,
      clientEmail: null,
      customerId: null,
      savedMethod: null,
      failureCode: null,
      livemode,
      customAmount: null,
      capture: 'automatic',
      saveMethod: false,
      metadata: {},
      ...fields,
    };
    charges.set(charge.id, charge);
    return charge;
  }

  function priceFor(item: SubscriptionItemInput, currency: string): FakePrice {
    if (item.lookupKey) {
      const price = [...prices.values()].find((p) => p.lookupKey === item.lookupKey);
      if (!price) {
        throw new FakeProviderError(
          `no price with lookup key ${item.lookupKey}`,
          'resource_missing',
        );
      }
      return price;
    }
    if (item.priceId) return must(prices, item.priceId, 'price');
    const inline = item.inline;
    if (!inline)
      throw new FakeProviderError('a subscription item needs a price', 'parameter_missing');
    const price: FakePrice = {
      id: nextId('price_fake'),
      lookupKey: '',
      name: inline.name,
      unitAmount: inline.unitAmount,
      currency,
      interval: inline.interval,
      intervalCount: inline.intervalCount,
      metered: false,
      features: [],
    };
    prices.set(price.id, price);
    return price;
  }

  function subscriptionItem(price: FakePrice, quantity: number): ProviderSubscriptionItem {
    return {
      id: nextId('si_fake'),
      priceId: price.id,
      lookupKey: price.lookupKey || null,
      name: price.name,
      unitAmount: price.unitAmount,
      currency: price.currency,
      interval: price.interval,
      intervalCount: price.intervalCount,
      quantity: price.metered ? 0 : quantity,
      metered: price.metered,
    };
  }

  function grantEntitlements(sub: FakeSubscriptionRecord): void {
    const live = ['trialing', 'active', 'past_due'].includes(sub.status);
    const features = live
      ? [...new Set(sub.items.flatMap((item) => prices.get(item.priceId)?.features ?? []))].sort()
      : [];
    entitlementsByCustomer.set(sub.customerId, features);
  }

  function invoiceFor(sub: FakeSubscriptionRecord, paid: boolean, reason: string) {
    const amount = sub.items
      .filter((item) => !item.metered)
      .reduce((sum, item) => sum + (item.unitAmount ?? 0) * item.quantity, 0);
    const invoice: FakeInvoiceRecord = {
      id: nextId('in_fake'),
      reference: null,
      subscriptionId: sub.id,
      customerId: sub.customerId,
      status: paid ? 'paid' : 'open',
      currency: sub.currency,
      amountDue: amount,
      amountPaid: paid ? amount : 0,
      amountRemaining: paid ? 0 : amount,
      hostedUrl: `https://invoice.fake.test/${counter}`,
      pdfUrl: null,
      number: `FAKE-${counter}`,
      dueDate: null,
      paymentId: paid ? nextId('pi_fake') : null,
      periodStart: now(),
      periodEnd: sub.currentPeriodEnd,
      billingReason: reason,
      attemptCount: 1,
      livemode,
      accountId: sub.accountId,
    };
    invoices.set(invoice.id, invoice);
    sub.latestInvoiceId = invoice.id;
    return invoice;
  }

  function relatedCharge(chargeId: string): ProviderStateChange {
    const charge = must(charges, chargeId, 'charge');
    return { kind: 'charge', accountId: charge.accountId, charge: chargeView(charge) };
  }

  const provider: FakePaymentProvider = {
    id,
    displayName: 'Fake payments',
    publishableKey: 'pk_fake',
    calls,
    accounts,
    customers,
    methods,
    charges,
    refunds,
    disputes,
    subscriptions,
    subscriptionCheckouts,
    setupSessions,
    invoices,
    links,
    transfers,
    payouts,
    prices,
    entitlementsByCustomer,
    usage,

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
      return !event.type.startsWith('ignored.');
    },

    // ── Sellers ──

    async createMerchantAccount(input) {
      record('createMerchantAccount', input);
      return once(input.idempotencyKey, () => {
        const account: FakeAccount = {
          id: nextId('acct_fake'),
          dashboard: input.dashboard,
          feesCollector: input.feesCollector,
          lossesCollector: input.lossesCollector,
          country: input.country,
          defaultCurrency: input.defaultCurrency ?? null,
          chargesEnabled: false,
          transfersEnabled: false,
          payoutsEnabled: false,
          requirementsDue: ['Business details', 'Bank account'],
          requirementsPastDue: [],
          disabledReason: null,
          closed: false,
          livemode,
          requested: { ...input.capabilities },
          payoutSchedule: { interval: 'daily', delayDays: 2 },
          metadata: { ...input.metadata },
        };
        accounts.set(account.id, account);
        return accountView(account);
      });
    },
    async retrieveMerchantAccount(accountId) {
      record('retrieveMerchantAccount', { accountId });
      return accountView(must(accounts, accountId, 'account'));
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

    // ── Charges ──

    async createClient(input) {
      record('createClient', input);
      return once(input.idempotencyKey, () => {
        const customer: FakeCustomer = {
          id: nextId('cus_fake'),
          accountId: input.sellerAccountId,
          email: input.email ?? null,
          name: input.name ?? null,
          metadata: { ...input.metadata },
        };
        customers.set(customer.id, customer);
        return { clientId: customer.id };
      });
    },
    async createCharge(input) {
      record('createCharge', input);
      requireCanBePaid(input);
      const where = home(input);
      customerOn(input.clientId, where);
      return once(input.idempotencyKey, () => {
        const items = input.items.map((item) => ({ ...item }));
        if (!input.customAmount && input.platformFeeAmount > subtotal(items)) {
          throw new FakeProviderError(
            'the application fee cannot exceed the amount',
            'invalid_fee',
          );
        }
        const charge = newCharge({
          accountId: where,
          sellerAccountId: input.sellerAccountId,
          kind: 'checkout',
          items,
          currency: input.currency,
          reference: input.reference,
          customAmount: input.customAmount ?? null,
          capture: input.capture,
          saveMethod: input.saveMethod,
          platformFeeAmount: input.platformFeeAmount,
          expiresAt: input.expiresAt,
          clientEmail: input.clientEmail ?? null,
          customerId: input.clientId ?? null,
          metadata: { ...input.metadata },
        });
        charge.url = input.ui === 'embedded' ? null : `https://pay.fake.test/${charge.id}`;
        charge.clientSecret = input.ui === 'embedded' ? `${charge.id}_secret` : null;
        return chargeView(charge);
      });
    },
    async createInvoiceCharge(input) {
      record('createInvoiceCharge', input);
      requireCanBePaid(input);
      const where = home(input);
      customerOn(input.clientId, where);
      return once(input.idempotencyKey, () => {
        const charge = newCharge({
          accountId: where,
          sellerAccountId: input.sellerAccountId,
          kind: 'invoice',
          items: input.items.map((item) => ({ ...item })),
          currency: input.currency,
          reference: input.reference,
          platformFeeAmount: input.platformFeeAmount,
          customerId: input.clientId,
          clientEmail: customers.get(input.clientId)?.email ?? null,
          expiresAt: new Date(Date.now() + input.dueInDays * DAY),
          metadata: { ...input.metadata },
        });
        charge.url = `https://invoice.fake.test/${charge.id}`;
        return chargeView(charge);
      });
    },
    async chargeSavedMethod(input) {
      record('chargeSavedMethod', input);
      requireCanBePaid(input);
      const where = home(input);
      customerOn(input.clientId, where);
      const method = must(methods, input.methodId, 'payment method');
      if (method.detached || method.customerId !== input.clientId) {
        throw new FakeProviderError(
          'the payment method is not attached to this customer',
          'resource_missing',
        );
      }
      return once(input.idempotencyKey, () => {
        const charge = newCharge({
          accountId: where,
          sellerAccountId: input.sellerAccountId,
          kind: 'payment',
          items: [{ name: input.description, unitAmount: input.amount, quantity: 1 }],
          currency: input.currency,
          reference: input.reference,
          capture: input.capture,
          platformFeeAmount: input.platformFeeAmount,
          customerId: input.clientId,
          metadata: { ...input.metadata },
        });
        charge.paymentId = charge.id;
        if (savedMethodOutcome === 'paid') {
          if (input.capture === 'manual') {
            charge.status = 'authorized';
            charge.amountCapturable = input.amount;
            charge.captureBefore = new Date(Date.now() + 7 * DAY);
          } else {
            charge.status = 'paid';
            charge.paidAt = now();
          }
        } else {
          charge.status = savedMethodOutcome;
          charge.failureCode =
            savedMethodOutcome === 'requires_action' ? 'authentication_required' : 'card_declined';
        }
        savedMethodOutcome = 'paid';
        return chargeView(charge);
      });
    },
    async captureCharge(input) {
      record('captureCharge', input);
      return once(input.idempotencyKey, () => {
        const charge = [...charges.values()].find((c) => c.paymentId === input.paymentId);
        if (!charge || charge.status !== 'authorized') {
          throw new FakeProviderError('nothing to capture', 'payment_intent_unexpected_state');
        }
        const amount = input.amount ?? charge.amountCapturable ?? charge.amountTotal ?? 0;
        charge.status = 'paid';
        charge.amountTotal = amount;
        charge.amountCapturable = 0;
        charge.paidAt = now();
        if (input.platformFeeAmount !== undefined)
          charge.platformFeeAmount = input.platformFeeAmount;
        return chargeView(charge);
      });
    },
    async cancelCharge(input) {
      record('cancelCharge', input);
      const checkout = subscriptionCheckouts.get(input.chargeId);
      if (checkout) {
        checkout.status = 'expired';
        return chargeView(
          newCharge({
            accountId: checkout.accountId,
            sellerAccountId: null,
            kind: 'checkout',
            items: [],
            currency: checkout.currency,
            status: 'expired',
          }),
        );
      }
      const charge =
        charges.get(input.chargeId) ??
        [...charges.values()].find((c) => input.paymentId && c.paymentId === input.paymentId);
      if (!charge)
        throw new FakeProviderError(`unknown charge ${input.chargeId}`, 'resource_missing');
      charge.status =
        charge.status === 'authorized' || charge.kind === 'invoice' ? 'canceled' : 'expired';
      charge.url = null;
      charge.amountCapturable = 0;
      return chargeView(charge);
    },
    async createRefund(input) {
      record('createRefund', input);
      return once(input.idempotencyKey, () => {
        const charge = [...charges.values()].find((c) => c.paymentId === input.paymentId);
        if (!charge) {
          throw new FakeProviderError(`unknown payment ${input.paymentId}`, 'resource_missing');
        }
        const held = [...refunds.values()]
          .filter(
            (r) =>
              r.paymentId === input.paymentId && r.status !== 'failed' && r.status !== 'canceled',
          )
          .reduce((sum, r) => sum + r.amount, 0);
        const paid = charge.amountTotal ?? charge.amountSubtotal ?? 0;
        const amount = input.amount ?? paid - held;
        if (amount <= 0 || held + amount > paid) {
          throw new FakeProviderError(
            'refund amount is greater than the unrefunded amount',
            'amount_too_large',
          );
        }
        const refund: FakeRefundRecord = {
          id: nextId('re_fake'),
          accountId: charge.accountId,
          chargeId: charge.id,
          reference: input.reference,
          paymentId: input.paymentId,
          amount,
          currency: charge.currency,
          status: 'pending',
          reason: input.reason ?? null,
          failureReason: null,
        };
        refunds.set(refund.id, refund);
        return refundView(refund);
      });
    },
    async findRefund(input) {
      record('findRefund', input);
      const refund = [...refunds.values()].find(
        (r) => r.reference === input.reference && r.paymentId === input.paymentId,
      );
      return refund ? refundView(refund) : null;
    },

    // ── Saved payment methods and the portal ──

    async createSetupSession(input) {
      record('createSetupSession', input);
      customerOn(input.clientId, input.sellerAccountId);
      return once(input.idempotencyKey, () => {
        const session: FakeSetupSession = {
          id: nextId('seti_fake'),
          accountId: input.sellerAccountId,
          customerId: input.clientId,
          reference: input.reference,
          status: 'open',
          methodId: null,
          url: '',
        };
        session.url = `https://setup.fake.test/${session.id}`;
        setupSessions.set(session.id, session);
        return {
          id: session.id,
          url: session.url,
          clientSecret: null,
          expiresAt: new Date(Date.now() + DAY),
        };
      });
    },
    async listPaymentMethods(input) {
      record('listPaymentMethods', input);
      return [...methods.values()]
        .filter((m) => m.customerId === input.clientId && !m.detached)
        .map(methodView);
    },
    async detachPaymentMethod(input) {
      record('detachPaymentMethod', input);
      must(methods, input.methodId, 'payment method').detached = true;
    },
    async createPortalSession(input) {
      record('createPortalSession', input);
      customerOn(input.clientId, input.sellerAccountId);
      return { url: `https://portal.fake.test/${input.clientId}` };
    },

    // ── Subscriptions ──

    async createSubscriptionCheckout(input) {
      record('createSubscriptionCheckout', input);
      requireCanBePaid(input);
      const where = home(input);
      customerOn(input.clientId, where);
      return once(input.idempotencyKey, () => {
        for (const item of input.items) priceFor(item, input.currency);
        const checkout: FakeSubscriptionCheckout = {
          id: nextId('cs_sub_fake'),
          accountId: where,
          reference: input.reference,
          customerId: input.clientId,
          currency: input.currency,
          items: input.items.map((item) => ({ ...item })),
          trialDays: input.trialDays ?? null,
          applicationFeePercent: input.applicationFeePercent ?? null,
          status: 'open',
          subscriptionId: null,
          url: '',
          metadata: { ...input.metadata },
        };
        checkout.url = `https://pay.fake.test/${checkout.id}`;
        subscriptionCheckouts.set(checkout.id, checkout);
        return {
          id: checkout.id,
          url: input.ui === 'embedded' ? null : checkout.url,
          clientSecret: input.ui === 'embedded' ? `${checkout.id}_secret` : null,
          expiresAt: input.expiresAt,
        };
      });
    },
    async retrieveSubscription(input) {
      record('retrieveSubscription', input);
      return subscriptionView(must(subscriptions, input.subscriptionId, 'subscription'));
    },
    async updateSubscription(input) {
      record('updateSubscription', input);
      return once(input.idempotencyKey, () => {
        const sub = must(subscriptions, input.subscriptionId, 'subscription');
        for (const change of input.items ?? []) {
          const index = change.itemId
            ? sub.items.findIndex((item) => item.id === change.itemId)
            : -1;
          const current = index >= 0 ? sub.items[index] : undefined;
          if (change.deleted) {
            if (index >= 0) sub.items.splice(index, 1);
            continue;
          }
          const price =
            change.priceId || change.lookupKey
              ? priceFor(
                  {
                    ...(change.priceId ? { priceId: change.priceId } : {}),
                    ...(change.lookupKey ? { lookupKey: change.lookupKey } : {}),
                  },
                  sub.currency,
                )
              : current
                ? must(prices, current.priceId, 'price')
                : null;
          if (!price) continue;
          const item = subscriptionItem(price, change.quantity ?? current?.quantity ?? 1);
          if (current) sub.items[index] = { ...item, id: current.id };
          else sub.items.push(item);
        }
        if (input.cancelAtPeriodEnd !== undefined) sub.cancelAtPeriodEnd = input.cancelAtPeriodEnd;
        grantEntitlements(sub);
        return subscriptionView(sub);
      });
    },
    async cancelSubscription(input) {
      record('cancelSubscription', input);
      return once(input.idempotencyKey, () => {
        const sub = must(subscriptions, input.subscriptionId, 'subscription');
        if (input.atPeriodEnd) {
          sub.cancelAtPeriodEnd = true;
        } else {
          sub.status = 'canceled';
          sub.canceledAt = now();
          sub.endedAt = now();
        }
        grantEntitlements(sub);
        return subscriptionView(sub);
      });
    },

    // ── Payment links ──

    async createPaymentLink(input) {
      record('createPaymentLink', input);
      requireCanBePaid(input);
      const link: FakeLink = {
        id: nextId('plink_fake'),
        accountId: home(input),
        sellerAccountId: input.sellerAccountId,
        reference: input.reference,
        currency: input.currency,
        items: input.items.map(({ adjustableQuantity: _quantity, ...item }) => ({ ...item })),
        customAmount: input.customAmount ?? null,
        platformFeeAmount: input.platformFeeAmount,
        active: true,
        url: '',
      };
      link.url = `https://buy.fake.test/${link.id}`;
      links.set(link.id, link);
      return { id: link.id, url: link.url, active: true };
    },
    async updatePaymentLink(input) {
      record('updatePaymentLink', input);
      const link = must(links, input.linkId, 'payment link');
      link.active = input.active;
      return { id: link.id, url: link.url, active: link.active };
    },

    // ── Transfers and payouts ──

    async createTransfer(input) {
      record('createTransfer', input);
      return once(input.idempotencyKey, () => {
        const account = must(accounts, input.destinationAccountId, 'account');
        if (!account.transfersEnabled) {
          throw new FakeProviderError('destination cannot receive transfers', 'account_invalid');
        }
        const transfer: ProviderTransfer = {
          id: nextId('tr_fake'),
          reference: input.reference,
          destinationAccountId: input.destinationAccountId,
          amount: input.amount,
          currency: input.currency,
          amountReversed: 0,
          transferGroup: input.transferGroup,
          sourcePaymentId: input.sourcePaymentId,
          livemode,
        };
        transfers.set(transfer.id, transfer);
        transferMetadata.set(transfer.id, { ...input.metadata });
        return { ...transfer };
      });
    },
    async reverseTransfer(input) {
      record('reverseTransfer', input);
      return once(input.idempotencyKey, () => {
        const transfer = must(transfers, input.transferId, 'transfer');
        const amount = input.amount ?? transfer.amount - transfer.amountReversed;
        if (transfer.amountReversed + amount > transfer.amount) {
          throw new FakeProviderError('reversal exceeds the transfer', 'amount_too_large');
        }
        transfer.amountReversed += amount;
        return { ...transfer };
      });
    },
    async retrievePayoutSettings(input) {
      record('retrievePayoutSettings', input);
      const account = must(accounts, input.accountId, 'account');
      return { schedule: { ...account.payoutSchedule }, instantAvailable: account.payoutsEnabled };
    },
    async updatePayoutSchedule(input) {
      record('updatePayoutSchedule', input);
      const account = must(accounts, input.accountId, 'account');
      account.payoutSchedule = { ...input.schedule };
      return { schedule: { ...account.payoutSchedule }, instantAvailable: account.payoutsEnabled };
    },
    async listPayouts(input) {
      record('listPayouts', input);
      return [...payouts.values()]
        .filter((p) => p.accountId === input.accountId)
        .slice(0, input.limit)
        .map(({ accountId: _accountId, ...payout }) => payout);
    },
    async createPayout(input) {
      record('createPayout', input);
      return once(input.idempotencyKey, () => {
        const account = must(accounts, input.accountId, 'account');
        if (!account.payoutsEnabled) {
          throw new FakeProviderError('payouts are not enabled', 'account_invalid');
        }
        const payout = {
          id: nextId('po_fake'),
          accountId: input.accountId,
          amount: input.amount,
          currency: input.currency,
          status: 'pending' as PayoutStatus,
          method: input.method,
          arrivalDate: new Date(Date.now() + (input.method === 'instant' ? 30 * 60_000 : 2 * DAY)),
          failureCode: null,
          livemode,
        };
        payouts.set(payout.id, payout);
        const { accountId: _accountId, ...view } = payout;
        return view;
      });
    },

    // ── Disputes ──

    async updateDispute(input) {
      record('updateDispute', input);
      const dispute = must(disputes, input.disputeId, 'dispute');
      if (input.submit) {
        dispute.evidenceSubmitted = true;
        dispute.status = 'under_review';
        dispute.providerStatus = 'under_review';
      }
      const { accountId: _accountId, chargeId: _chargeId, ...view } = dispute;
      return view;
    },
    async acceptDispute(input) {
      record('acceptDispute', input);
      const dispute = must(disputes, input.disputeId, 'dispute');
      dispute.status = 'lost';
      dispute.providerStatus = 'lost';
      const { accountId: _accountId, chargeId: _chargeId, ...view } = dispute;
      return view;
    },

    // ── Platform billing ──

    async createBillingCustomer(input) {
      record('createBillingCustomer', input);
      return once(input.idempotencyKey, () => {
        const customer: FakeCustomer = {
          id: nextId('cus_fake'),
          accountId: null,
          email: input.email ?? null,
          name: input.name ?? null,
          metadata: { ...input.metadata },
        };
        customers.set(customer.id, customer);
        return { customerId: customer.id };
      });
    },
    async syncCatalog(input) {
      record('syncCatalog', input);
      return catalog(input, true);
    },
    async checkCatalog(input) {
      record('checkCatalog', input);
      return catalog(input, false);
    },
    async listEntitlements(input) {
      record('listEntitlements', input);
      return [...(entitlementsByCustomer.get(input.customerId) ?? [])];
    },
    async recordUsage(input) {
      record('recordUsage', input);
      if (usage.some((u) => u.identifier === input.identifier)) return;
      usage.push({
        customerId: input.customerId,
        eventName: input.eventName,
        value: input.value,
        identifier: input.identifier,
      });
    },

    // ── Webhooks ──

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
        routing?: VerifiedProviderEvent['routing'];
      };
      return {
        eventId: body.id,
        type: body.type,
        format: 'thin',
        livemode: body.livemode,
        occurredAt: new Date(body.created),
        accountId: body.account,
        objectId: body.object.id,
        objectType: body.object.type,
        routing: body.routing ?? {
          tenantId: null,
          customerId: null,
          paymentId: null,
          subscriptionId: null,
        },
        payload: body,
      };
    },

    async resolveEvent(event: StoredProviderEvent) {
      record('resolveEvent', event);
      const objectId = event.objectId ?? '';
      switch (event.objectType as FakeObjectType) {
        case 'account':
          return [{ kind: 'merchant', account: accountView(must(accounts, objectId, 'account')) }];
        case 'charge': {
          const charge = must(charges, objectId, 'charge');
          const changes: ProviderStateChange[] = [relatedCharge(objectId)];
          if (charge.savedMethod) {
            changes.push({
              kind: 'payment_method',
              accountId: charge.accountId,
              method: { ...charge.savedMethod },
              detached: false,
            });
          }
          return changes;
        }
        case 'refund': {
          const refund = must(refunds, objectId, 'refund');
          const charge = must(charges, refund.chargeId, 'charge');
          // The charge first, like real providers: it carries the payment id refunds match on.
          return [
            relatedCharge(charge.id),
            {
              kind: 'refund',
              accountId: refund.accountId,
              chargeReference: charge.reference,
              refund: refundView(refund),
            },
          ];
        }
        case 'dispute': {
          const dispute = must(disputes, objectId, 'dispute');
          const charge = must(charges, dispute.chargeId, 'charge');
          const { accountId, chargeId: _chargeId, ...rest } = dispute;
          return [{ kind: 'dispute', accountId, chargeReference: charge.reference, dispute: rest }];
        }
        case 'setup':
        case 'payment_method': {
          const methodId =
            event.objectType === 'setup'
              ? (must(setupSessions, objectId, 'setup session').methodId ?? '')
              : objectId;
          const method = must(methods, methodId, 'payment method');
          return [
            {
              kind: 'payment_method',
              accountId: method.accountId,
              method: methodView(method),
              detached: method.detached,
            },
          ];
        }
        case 'subscription': {
          const sub = must(subscriptions, objectId, 'subscription');
          return [
            { kind: 'subscription', accountId: sub.accountId, subscription: subscriptionView(sub) },
          ];
        }
        case 'subscription_checkout': {
          const checkout = must(subscriptionCheckouts, objectId, 'subscription checkout');
          if (checkout.status === 'expired') {
            return [
              {
                kind: 'subscription_checkout_expired',
                accountId: checkout.accountId,
                checkoutId: checkout.id,
                reference: checkout.reference,
              },
            ];
          }
          if (!checkout.subscriptionId) return [];
          const sub = must(subscriptions, checkout.subscriptionId, 'subscription');
          return [
            { kind: 'subscription', accountId: sub.accountId, subscription: subscriptionView(sub) },
          ];
        }
        case 'invoice': {
          const invoice = must(invoices, objectId, 'invoice');
          const changes: ProviderStateChange[] = [];
          if (invoice.subscriptionId) {
            const sub = must(subscriptions, invoice.subscriptionId, 'subscription');
            changes.push({
              kind: 'subscription',
              accountId: sub.accountId,
              subscription: subscriptionView(sub),
            });
          }
          changes.push({
            kind: 'invoice',
            accountId: invoice.accountId,
            invoice: invoiceView(invoice),
          });
          return changes;
        }
        case 'transfer':
          return [{ kind: 'transfer', transfer: { ...must(transfers, objectId, 'transfer') } }];
        case 'payout': {
          const { accountId, ...payout } = must(payouts, objectId, 'payout');
          return [{ kind: 'payout', accountId, payout }];
        }
        case 'entitlements':
          return [
            {
              kind: 'entitlements',
              customerId: objectId,
              features: [...(entitlementsByCustomer.get(objectId) ?? [])],
            },
          ];
        default:
          return [];
      }
    },

    // ── Lifecycle helpers ──

    completeOnboarding(accountId) {
      const account = must(accounts, accountId, 'account');
      Object.assign(account, {
        chargesEnabled: account.requested.cardPayments,
        transfersEnabled: account.requested.transfers,
        payoutsEnabled: true,
        requirementsDue: [],
        requirementsPastDue: [],
        disabledReason: null,
      });
      return accountView(account);
    },
    restrictAccount(accountId, requirement) {
      const account = must(accounts, accountId, 'account');
      Object.assign(account, {
        chargesEnabled: false,
        transfersEnabled: false,
        requirementsDue: [requirement],
        requirementsPastDue: [requirement],
        disabledReason: 'requirements_past_due',
      });
      return accountView(account);
    },
    closeAccount(accountId) {
      const account = must(accounts, accountId, 'account');
      Object.assign(account, {
        closed: true,
        chargesEnabled: false,
        transfersEnabled: false,
        payoutsEnabled: false,
      });
      return accountView(account);
    },
    setChargeStatus(chargeId, status) {
      const charge = must(charges, chargeId, 'charge');
      charge.status = status;
      if (status !== 'open') charge.url = null;
      return charge;
    },
    payCharge(chargeId, payOptions = {}) {
      const charge = must(charges, chargeId, 'charge');
      if (charge.customAmount) {
        const amount =
          payOptions.amount ?? charge.customAmount.preset ?? charge.customAmount.minimum ?? 0;
        charge.amountSubtotal = amount;
      }
      const discount = payOptions.discount ?? 0;
      const tax = payOptions.tax ?? 0;
      charge.amountDiscount = discount;
      charge.amountTax = tax;
      charge.amountTotal = (charge.amountSubtotal ?? 0) - discount + tax;
      charge.paymentId = charge.paymentId ?? nextId('pi_fake');
      charge.url = null;
      if (charge.capture === 'manual') {
        charge.status = 'authorized';
        charge.amountCapturable = charge.amountTotal;
        charge.captureBefore = new Date(Date.now() + 7 * DAY);
      } else {
        charge.status = 'paid';
        charge.paidAt = now();
      }
      if (charge.saveMethod && charge.customerId) {
        const method: FakeMethod = {
          id: nextId('pm_fake'),
          customerId: charge.customerId,
          type: 'card',
          brand: 'visa',
          last4: '4242',
          expMonth: 12,
          expYear: 2034,
          accountId: charge.accountId,
          detached: false,
        };
        methods.set(method.id, method);
        charge.savedMethod = methodView(method);
      }
      return charge;
    },
    setSavedMethodOutcome(outcome) {
      savedMethodOutcome = outcome;
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
        amount: disputeOptions.amount ?? charge.amountTotal ?? 0,
        currency: charge.currency,
        status: 'needs_response',
        providerStatus: 'needs_response',
        reason: disputeOptions.reason ?? 'fraudulent',
        evidenceDueBy: new Date(Date.now() + 7 * DAY),
        evidenceSubmitted: false,
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
    completeSetup(setupId, card = {}) {
      const session = must(setupSessions, setupId, 'setup session');
      const method: FakeMethod = {
        id: nextId('pm_fake'),
        customerId: session.customerId,
        type: 'card',
        brand: card.brand ?? 'visa',
        last4: card.last4 ?? '4242',
        expMonth: 12,
        expYear: 2034,
        accountId: session.accountId,
        detached: false,
      };
      methods.set(method.id, method);
      session.status = 'complete';
      session.methodId = method.id;
      return method;
    },
    completeSubscriptionCheckout(checkoutId) {
      const checkout = must(subscriptionCheckouts, checkoutId, 'subscription checkout');
      const trialDays = checkout.trialDays ?? 0;
      const items = checkout.items.map((item) =>
        subscriptionItem(priceFor(item, checkout.currency), item.quantity ?? 1),
      );
      const first = items[0];
      const periodMs = first ? INTERVAL_MS[first.interval] * first.intervalCount : 30 * DAY;
      const sub: FakeSubscriptionRecord = {
        id: nextId('sub_fake'),
        reference: checkout.reference,
        customerId: checkout.customerId,
        status: trialDays > 0 ? 'trialing' : 'active',
        currency: checkout.currency,
        items,
        currentPeriodEnd: new Date(Date.now() + (trialDays > 0 ? trialDays * DAY : periodMs)),
        cancelAtPeriodEnd: false,
        canceledAt: null,
        endedAt: null,
        trialEnd: trialDays > 0 ? new Date(Date.now() + trialDays * DAY) : null,
        latestInvoiceId: null,
        applicationFeePercent: checkout.applicationFeePercent,
        livemode,
        accountId: checkout.accountId,
        metadata: { ...checkout.metadata },
      };
      subscriptions.set(sub.id, sub);
      checkout.status = 'complete';
      checkout.subscriptionId = sub.id;
      invoiceFor(sub, true, 'subscription_create');
      grantEntitlements(sub);
      return sub;
    },
    expireSubscriptionCheckout(checkoutId) {
      const checkout = must(subscriptionCheckouts, checkoutId, 'subscription checkout');
      checkout.status = 'expired';
      return checkout;
    },
    renewSubscription(subscriptionId, renewOptions = {}) {
      const sub = must(subscriptions, subscriptionId, 'subscription');
      const paid = renewOptions.paid ?? true;
      const first = sub.items[0];
      sub.currentPeriodEnd = new Date(
        (sub.currentPeriodEnd ?? now()).getTime() +
          (first ? INTERVAL_MS[first.interval] * first.intervalCount : 30 * DAY),
      );
      sub.trialEnd = null;
      sub.status = paid ? 'active' : 'past_due';
      const invoice = invoiceFor(sub, paid, 'subscription_cycle');
      grantEntitlements(sub);
      return invoice;
    },
    payLink(linkId, payOptions = {}) {
      const link = must(links, linkId, 'payment link');
      if (!link.active) throw new Error('fake provider: the link is inactive');
      const items = link.items.map((item, index) => ({
        ...item,
        ...(index === 0 && payOptions.quantity ? { quantity: payOptions.quantity } : {}),
        ...(index === 0 && payOptions.amount ? { unitAmount: payOptions.amount } : {}),
      }));
      const charge = newCharge({
        accountId: link.accountId,
        sellerAccountId: link.sellerAccountId,
        kind: 'checkout',
        items,
        currency: link.currency,
        linkId: link.id,
        platformFeeAmount: link.platformFeeAmount,
        clientEmail: payOptions.email ?? 'buyer@example.com',
      });
      charge.amountSubtotal = subtotal(items);
      charge.amountTotal = charge.amountSubtotal;
      charge.paymentId = nextId('pi_fake');
      charge.status = 'paid';
      charge.paidAt = now();
      return charge;
    },
    payoutSeller(accountId, payoutOptions) {
      must(accounts, accountId, 'account');
      const status = payoutOptions.status ?? 'pending';
      const payout = {
        id: nextId('po_fake'),
        accountId,
        amount: payoutOptions.amount,
        currency: payoutOptions.currency ?? 'usd',
        status,
        method: 'standard' as const,
        arrivalDate: new Date(Date.now() + 2 * DAY),
        failureCode: status === 'failed' ? 'account_closed' : null,
        livemode,
      };
      payouts.set(payout.id, payout);
      const { accountId: _accountId, ...view } = payout;
      return view;
    },
    setPayoutStatus(payoutId, status) {
      const payout = must(payouts, payoutId, 'payout');
      payout.status = status;
      payout.failureCode = status === 'failed' ? 'account_closed' : null;
      const { accountId: _accountId, ...view } = payout;
      return view;
    },
    failNext(method, error) {
      failures.set(method, error);
    },
    event(objectType, objectId, eventOptions = {}) {
      const body = JSON.stringify({
        id: eventOptions.eventId ?? nextId('evt_fake'),
        type: eventOptions.type ?? `${objectType}.updated`,
        livemode: eventOptions.livemode ?? livemode,
        created: new Date().toISOString(),
        account: accountOf(objectType, objectId),
        object: { id: objectId, type: objectType },
        routing: routingOf(objectType, objectId),
      });
      return {
        rawBody: Buffer.from(body),
        headers: { 'content-type': 'application/json', [FAKE_SIGNATURE_HEADER]: sign(body) },
      };
    },
  };

  /** The account an event about an object comes from: its seller, or null for the platform. */
  function accountOf(objectType: FakeObjectType, objectId: string): string | null {
    switch (objectType) {
      case 'account':
        return objectId;
      case 'charge':
        return must(charges, objectId, 'charge').accountId;
      case 'refund':
        return must(refunds, objectId, 'refund').accountId;
      case 'dispute':
        return must(disputes, objectId, 'dispute').accountId;
      case 'payment_method':
        return must(methods, objectId, 'payment method').accountId;
      case 'setup':
        return must(setupSessions, objectId, 'setup session').accountId;
      case 'subscription':
        return must(subscriptions, objectId, 'subscription').accountId;
      case 'subscription_checkout':
        return must(subscriptionCheckouts, objectId, 'subscription checkout').accountId;
      case 'invoice':
        return must(invoices, objectId, 'invoice').accountId;
      case 'payout':
        return must(payouts, objectId, 'payout').accountId;
      default:
        return null;
    }
  }

  /** How a platform-level event finds its tenant: our metadata first, then ids. */
  function routingOf(
    objectType: FakeObjectType,
    objectId: string,
  ): VerifiedProviderEvent['routing'] {
    const empty = { tenantId: null, customerId: null, paymentId: null, subscriptionId: null };
    switch (objectType) {
      case 'charge': {
        const charge = must(charges, objectId, 'charge');
        return {
          ...empty,
          tenantId: charge.metadata.plumbus_tenant_id ?? null,
          customerId: charge.customerId,
          paymentId: charge.paymentId,
        };
      }
      case 'refund':
        return { ...empty, paymentId: must(refunds, objectId, 'refund').paymentId };
      case 'dispute':
        return { ...empty, paymentId: must(disputes, objectId, 'dispute').paymentId };
      case 'subscription':
        return {
          ...empty,
          tenantId:
            must(subscriptions, objectId, 'subscription').metadata.plumbus_tenant_id ?? null,
          subscriptionId: objectId,
        };
      case 'subscription_checkout':
        return {
          ...empty,
          tenantId:
            must(subscriptionCheckouts, objectId, 'subscription checkout').metadata
              .plumbus_tenant_id ?? null,
        };
      case 'invoice': {
        const invoice = must(invoices, objectId, 'invoice');
        return { ...empty, customerId: invoice.customerId, subscriptionId: invoice.subscriptionId };
      }
      case 'payment_method':
        return { ...empty, customerId: must(methods, objectId, 'payment method').customerId };
      case 'setup':
        return { ...empty, customerId: must(setupSessions, objectId, 'setup session').customerId };
      case 'transfer':
        return {
          ...empty,
          tenantId: transferMetadata.get(objectId)?.plumbus_tenant_id ?? null,
          paymentId: must(transfers, objectId, 'transfer').sourcePaymentId,
        };
      case 'entitlements':
        return { ...empty, customerId: objectId };
      default:
        return empty;
    }
  }

  /** Create (or check) catalog prices by lookup key; a changed price becomes a new price. */
  function catalog(input: CatalogInput, write: boolean) {
    const result = { prices: {} as Record<string, string>, changes: [] as string[] };
    const wantedPrices = [
      ...input.plans.flatMap((plan) =>
        plan.prices.map((price) => ({
          lookupKey: price.lookupKey,
          name: plan.name,
          unitAmount: price.amount as number | null,
          currency: price.currency,
          interval: price.interval,
          intervalCount: price.intervalCount,
          metered: false,
          features: [...plan.features].sort(),
        })),
      ),
      ...input.meters.map((meter) => ({
        lookupKey: meter.lookupKey,
        name: meter.name,
        unitAmount: null as number | null,
        currency: meter.currency,
        interval: meter.interval,
        intervalCount: 1,
        metered: true,
        features: [] as string[],
      })),
    ];
    for (const wanted of wantedPrices) {
      const existing = [...prices.values()].find((p) => p.lookupKey === wanted.lookupKey);
      const same =
        existing !== undefined &&
        existing.unitAmount === wanted.unitAmount &&
        existing.currency === wanted.currency &&
        existing.interval === wanted.interval &&
        existing.intervalCount === wanted.intervalCount &&
        existing.features.join() === wanted.features.join();
      if (existing && same) {
        result.prices[wanted.lookupKey] = existing.id;
        continue;
      }
      result.changes.push(`${existing ? 'update' : 'create'} price ${wanted.lookupKey}`);
      if (!write) continue;
      // The lookup key moves to the new price; subscribers keep the old one.
      if (existing) existing.lookupKey = '';
      const price: FakePrice = { id: nextId('price_fake'), ...wanted };
      prices.set(price.id, price);
      result.prices[wanted.lookupKey] = price.id;
    }
    return result;
  }

  return provider;
}
