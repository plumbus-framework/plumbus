// ── createPayments() ──
// Validates the app's config against general and provider rules, then builds
// the capability set bound to that provider. Call it once, in
// app/payments/index.ts, and re-export the pieces from app/capabilities,
// app/entities, and app/events so discovery registers them.

import { ErrorCode, PlumbusError } from '@plumbus/core';
import { createChargeCapabilities } from '../capabilities/charges.js';
import { createInternalCapabilities } from '../capabilities/internal.js';
import { createMerchantCapabilities } from '../capabilities/merchant.js';
import { normalizePaymentsConfig } from '../config/normalize.js';
import { paymentEntities } from '../entities/index.js';
import { paymentEvents } from '../events/index.js';
import type { NormalizedPaymentsConfig, PaymentsConfig } from '../types/config.js';
import type { PaymentProvider, PaymentsFinding, WebhookSetupResult } from '../types/provider.js';
import type { PaymentsRuntime } from './runtime.js';

function buildCapabilities(runtime: PaymentsRuntime) {
  return {
    ...createMerchantCapabilities(runtime),
    ...createChargeCapabilities(runtime),
    ...createInternalCapabilities(runtime),
  };
}

export type PaymentCapabilities = ReturnType<typeof buildCapabilities>;

export interface Payments {
  readonly provider: PaymentProvider;
  readonly config: NormalizedPaymentsConfig;
  /** Advice found at startup (warnings and info). Errors throw instead. */
  readonly findings: readonly PaymentsFinding[];
  /** Every payments capability. Re-export all of them from app/capabilities. */
  readonly capabilities: PaymentCapabilities;
  readonly entities: typeof paymentEntities;
  readonly events: typeof paymentEvents;
  /** Config findings plus, with `live`, the provider's environment checks. */
  diagnose(options?: { live?: boolean; webhookUrl?: string }): Promise<PaymentsFinding[]>;
  /** Create the provider's webhook destinations for `url`. */
  setupWebhooks(options: { url: string }): Promise<WebhookSetupResult>;
}

export function createPayments(input: PaymentsConfig): Payments {
  const { config, provider, findings } = normalizePaymentsConfig(input);
  const capabilities = buildCapabilities({ config, provider });

  return Object.freeze({
    provider,
    config,
    findings: Object.freeze([...findings]),
    capabilities: Object.freeze(capabilities),
    entities: paymentEntities,
    events: paymentEvents,
    async diagnose(options: { live?: boolean; webhookUrl?: string } = {}) {
      const all: PaymentsFinding[] = [...findings];
      if (options.live) {
        if (provider.diagnose) {
          all.push(
            ...(await provider.diagnose(
              options.webhookUrl ? { webhookUrl: options.webhookUrl } : {},
            )),
          );
        } else {
          all.push({
            level: 'info',
            code: 'provider_has_no_live_checks',
            message: `${provider.displayName} does not offer live checks`,
          });
        }
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
      return provider.setupWebhooks(options);
    },
  });
}
