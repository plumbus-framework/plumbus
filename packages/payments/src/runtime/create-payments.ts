// ── createPayments() ──
// Validates the app's config against general and provider rules, then builds
// the capability set bound to that provider: only the features the config turns
// on. Call it once, in app/payments/index.ts, and export the collections from
// app/capabilities, app/entities, and app/events so discovery registers them.

import { ErrorCode, PlumbusError } from '@plumbus/core';
import { createBillingCapabilities } from '../capabilities/billing.js';
import { createChargeCapabilities } from '../capabilities/charges.js';
import { createClientCapabilities } from '../capabilities/clients.js';
import { createDisputeCapabilities } from '../capabilities/disputes.js';
import { createInternalCapabilities } from '../capabilities/internal.js';
import { createLinkCapabilities } from '../capabilities/links.js';
import { createMerchantCapabilities } from '../capabilities/merchant.js';
import { createPayoutCapabilities } from '../capabilities/payouts.js';
import { createSubscriptionCapabilities } from '../capabilities/subscriptions.js';
import { createTransferCapabilities } from '../capabilities/transfers.js';
import { normalizePaymentsConfig } from '../config/normalize.js';
import { PaymentEntityName, paymentEntities } from '../entities/index.js';
import { PaymentEventName, paymentEvents } from '../events/index.js';
import type { NormalizedPaymentsConfig, PaymentsConfig } from '../types/config.js';
import type {
  CatalogInput,
  CatalogResult,
  PaymentProvider,
  PaymentsFinding,
  WebhookSetupResult,
} from '../types/provider.js';
import { type BillingHelpers, catalogFor, createBillingHelpers } from './billing.js';
import { createPlatformHelpers, type PlatformHelpers } from './platform.js';
import type { PaymentsRuntime } from './runtime.js';

type CapabilitySet = Record<
  string,
  ReturnType<typeof createInternalCapabilities>[keyof ReturnType<typeof createInternalCapabilities>]
>;

export type PaymentCapabilities = ReturnType<typeof createInternalCapabilities> &
  Partial<
    ReturnType<typeof createMerchantCapabilities> &
      ReturnType<typeof createChargeCapabilities> &
      ReturnType<typeof createClientCapabilities> &
      ReturnType<typeof createDisputeCapabilities> &
      ReturnType<typeof createPayoutCapabilities> &
      ReturnType<typeof createSubscriptionCapabilities> &
      ReturnType<typeof createLinkCapabilities> &
      ReturnType<typeof createTransferCapabilities> &
      ReturnType<typeof createBillingCapabilities>
  > &
  CapabilitySet;

function buildCapabilities(runtime: PaymentsRuntime): PaymentCapabilities {
  const { config, provider } = runtime;
  const seller = config.seller
    ? {
        ...createMerchantCapabilities(runtime),
        ...createChargeCapabilities(runtime),
        ...createClientCapabilities(runtime),
        ...createDisputeCapabilities(runtime),
        ...createPayoutCapabilities(runtime),
        ...(provider.createPaymentLink ? createLinkCapabilities(runtime) : {}),
        ...(config.subscriptions.enabled ? createSubscriptionCapabilities(runtime) : {}),
        ...(config.transfers.enabled ? createTransferCapabilities(runtime) : {}),
      }
    : {};
  const billing = config.billing ? createBillingCapabilities(runtime) : {};
  return { ...seller, ...billing, ...createInternalCapabilities(runtime) } as PaymentCapabilities;
}

/** What a capability that calls the helpers must declare (spread into its effects). */
export interface HelperEffects {
  data: string[];
  events: string[];
  external: string[];
}

export interface Payments {
  readonly provider: PaymentProvider;
  readonly config: NormalizedPaymentsConfig;
  /** Advice found at startup (warnings and info). Errors throw instead. */
  readonly findings: readonly PaymentsFinding[];
  /** The payments capabilities this config enables. Export the collection from app/capabilities. */
  readonly capabilities: PaymentCapabilities;
  readonly entities: typeof paymentEntities;
  readonly events: typeof paymentEvents;
  /** Server-side money moves: platform charges and transfers to sellers. */
  readonly platform: PlatformHelpers;
  /** Server-side billing: seats, usage, features, one-off purchases, the AI usage bridge. */
  readonly billing: BillingHelpers;
  /** Effects to declare on your capabilities that call `platform` or `billing`. */
  readonly effects: { readonly platform: HelperEffects; readonly billing: HelperEffects };
  /** The provider catalog `billing` describes (null without billing). */
  readonly catalog: CatalogInput | null;
  /** Config findings plus, with `live`, the provider's environment and catalog checks. */
  diagnose(options?: { live?: boolean; webhookUrl?: string }): Promise<PaymentsFinding[]>;
  /** Create the provider's webhook destinations for `url`. */
  setupWebhooks(options: { url: string }): Promise<WebhookSetupResult>;
  /** Create or update the billing catalog at the provider. */
  syncCatalog(): Promise<CatalogResult>;
  /** Read-only: what `syncCatalog` would change at the provider. */
  checkCatalog(): Promise<CatalogResult>;
}

export function createPayments(input: PaymentsConfig): Payments {
  const { config, provider, findings } = normalizePaymentsConfig(input);
  const runtime: PaymentsRuntime = { config, provider };
  const capabilities = buildCapabilities(runtime);
  const platform = createPlatformHelpers(runtime);
  const billing = createBillingHelpers(runtime, platform);
  const catalog = catalogFor(runtime);
  const external = [`payments:${provider.id}`];

  return Object.freeze({
    provider,
    config,
    findings: Object.freeze([...findings]),
    capabilities: Object.freeze(capabilities),
    entities: paymentEntities,
    events: paymentEvents,
    platform,
    billing,
    effects: Object.freeze({
      platform: {
        data: [
          PaymentEntityName.Charge,
          PaymentEntityName.Client,
          PaymentEntityName.Refund,
          PaymentEntityName.Transfer,
        ],
        events: [
          PaymentEventName.ChargeCreated,
          PaymentEventName.ChargePaid,
          PaymentEventName.ChargeAuthorized,
          PaymentEventName.ChargeActionRequired,
          PaymentEventName.ChargeFailed,
          PaymentEventName.ChargeExpired,
          PaymentEventName.ChargeCanceled,
          PaymentEventName.TransferCreated,
          PaymentEventName.TransferReversed,
        ],
        external,
      },
      billing: {
        data: [
          PaymentEntityName.BillingCustomer,
          PaymentEntityName.Subscription,
          PaymentEntityName.Entitlement,
          PaymentEntityName.Charge,
        ],
        events: [
          PaymentEventName.SubscriptionUpdated,
          PaymentEventName.ChargeCreated,
          PaymentEventName.ChargePaid,
        ],
        external,
      },
    }),
    catalog,
    async diagnose(options: { live?: boolean; webhookUrl?: string } = {}) {
      const all: PaymentsFinding[] = [...findings];
      if (!options.live) return all;
      if (provider.diagnose) {
        all.push(
          ...(await provider.diagnose({
            ...(options.webhookUrl ? { webhookUrl: options.webhookUrl } : {}),
            ...(catalog ? { catalog } : {}),
            sellers: config.seller !== null,
          })),
        );
      } else {
        all.push({
          level: 'info',
          code: 'provider_has_no_live_checks',
          message: `${provider.displayName} does not offer live checks`,
        });
      }
      return all;
    },
    async setupWebhooks(options: { url: string }) {
      if (!provider.setupWebhooks) {
        throw new PlumbusError(
          ErrorCode.Validation,
          `${provider.displayName} cannot create webhook destinations`,
          { reason: 'payments_webhook_setup_unsupported' },
        );
      }
      return provider.setupWebhooks({ ...options, sellers: config.seller !== null });
    },
    async syncCatalog() {
      const input = requireCatalog('sync');
      if (!provider.syncCatalog) throw catalogUnsupported('create');
      return provider.syncCatalog(input);
    },
    async checkCatalog() {
      const input = requireCatalog('check');
      if (!provider.checkCatalog) throw catalogUnsupported('check');
      return provider.checkCatalog(input);
    },
  });

  function requireCatalog(verb: string): CatalogInput {
    if (!catalog) {
      throw new PlumbusError(ErrorCode.Validation, `Configure billing to ${verb} a catalog`, {
        reason: 'payments_billing_disabled',
      });
    }
    return catalog;
  }

  function catalogUnsupported(verb: string): PlumbusError {
    return new PlumbusError(
      ErrorCode.Validation,
      `${provider.displayName} cannot ${verb} a billing catalog`,
      { reason: 'payments_provider_feature_unsupported' },
    );
  }
}
