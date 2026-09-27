// ── Seller account capabilities ──
// Connect a seller account, mint onboarding links and embedded-component
// sessions, read status, pull fresh status, and open the seller's dashboard.

import { randomUUID } from 'node:crypto';
import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { PaymentEntityName } from '../entities/index.js';
import { PaymentEventName } from '../events/index.js';
import { deriveMerchantStatus, merchantChanged, syncedAfter } from '../runtime/apply-state.js';
import { merchantAccounts } from '../runtime/repos.js';
import {
  findOwnMerchant,
  merchantView,
  ownerMetadata,
  type PaymentsRuntime,
  requireOwnMerchant,
  resolveOwner,
} from '../runtime/runtime.js';
import type { MerchantComponent, MerchantDashboard } from '../types/provider.js';
import type { PaymentMerchantAccountRow } from '../types/records.js';
import { componentSchema, dashboardSchema, merchantViewSchema } from './schemas.js';

const external = (runtime: PaymentsRuntime) => [`payments:${runtime.provider.id}`];

export function createMerchantCapabilities(runtime: PaymentsRuntime) {
  const { config, provider } = runtime;

  const startMerchantOnboarding = defineCapability({
    name: 'startMerchantOnboarding',
    kind: 'action',
    domain: 'payments',
    description:
      "Connect the caller's seller account (created on first call) and return an onboarding link",
    input: z.object({
      dashboard: dashboardSchema.optional(),
      country: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .optional(),
      email: z.string().email().optional(),
      displayName: z.string().min(1).max(100).optional(),
      mode: z.enum(['hosted', 'embedded']).optional(),
    }),
    output: z.object({
      merchantAccount: merchantViewSchema,
      created: z.boolean(),
      onboardingUrl: z.string().nullable(),
      expiresAt: z.string().nullable(),
    }),
    access: config.access.sellers,
    effects: {
      data: [PaymentEntityName.MerchantAccount],
      events: [],
      external: external(runtime),
      ai: false,
    },
    audit: { event: 'payments.merchant.onboarding_started', includeInput: ['dashboard', 'mode'] },
    async handler(ctx, input) {
      const owner = resolveOwner(ctx, runtime);
      const mode =
        input.mode ?? (config.onboarding.modes.includes('hosted') ? 'hosted' : 'embedded');
      if (!config.onboarding.modes.includes(mode)) {
        throw ctx.errors.validation(`Onboarding mode "${mode}" is not enabled`, {
          reason: 'payments_onboarding_mode_disabled',
        });
      }

      let merchant = await findOwnMerchant(ctx, runtime, owner);
      let created = false;
      if (merchant) {
        if (input.dashboard && input.dashboard !== merchant.dashboard) {
          throw ctx.errors.conflict(
            `This payment account uses the ${merchant.dashboard} dashboard; the dashboard cannot change after an account exists`,
            { reason: 'payments_dashboard_permanent' },
          );
        }
        if (merchant.status === 'closed') {
          throw ctx.errors.conflict('This payment account is closed', {
            reason: 'payments_merchant_closed',
          });
        }
      } else {
        const dashboard = chooseDashboard(input.dashboard);
        if (!dashboard) {
          throw ctx.errors.validation(
            `Choose a dashboard: ${Object.keys(config.dashboards).join(', ')}`,
            { reason: 'payments_dashboard_required' },
          );
        }
        const responsibilities = config.dashboards[dashboard];
        if (!responsibilities) {
          throw ctx.errors.validation(`The ${dashboard} dashboard is not offered`, {
            reason: 'payments_dashboard_not_offered',
          });
        }
        const country = input.country ?? config.countries.default;
        if (!country) {
          throw ctx.errors.validation('Choose the country the seller is registered in', {
            reason: 'payments_country_required',
          });
        }
        if (config.countries.allowed && !config.countries.allowed.includes(country)) {
          throw ctx.errors.validation(`Sellers from ${country} are not supported`, {
            reason: 'payments_country_not_allowed',
          });
        }
        const livemode = await provider.resolveLivemode();
        const startedAt = ctx.time.now();
        const account = await provider.createMerchantAccount({
          dashboard,
          feesCollector: responsibilities.fees,
          lossesCollector: responsibilities.losses,
          country,
          ...(input.email ? { email: input.email } : {}),
          ...(input.displayName ? { displayName: input.displayName } : {}),
          metadata: ownerMetadata(runtime, owner),
          idempotencyKey: [
            'plumbus-merchant',
            owner.tenantId,
            owner.ownerType,
            owner.ownerId,
            livemode ? 'live' : 'test',
            dashboard,
            country,
          ].join(':'),
        });
        const status = deriveMerchantStatus(account);
        try {
          merchant = await merchantAccounts(ctx).create({
            id: randomUUID(),
            tenantId: owner.tenantId,
            ownerType: owner.ownerType,
            ownerId: owner.ownerId,
            provider: provider.id,
            providerAccountId: account.id,
            dashboard: account.dashboard,
            feesCollector: account.feesCollector,
            lossesCollector: account.lossesCollector,
            country: account.country ?? country,
            defaultCurrency: account.defaultCurrency,
            status,
            chargesEnabled: account.chargesEnabled,
            payoutsEnabled: account.payoutsEnabled,
            requirementsDue: account.requirementsDue,
            requirementsPastDue: account.requirementsPastDue,
            disabledReason: account.disabledReason,
            livemode: account.livemode,
            syncedAt: startedAt,
          });
          created = true;
        } catch (err) {
          // A concurrent call for the same owner won the insert; use its row.
          merchant = await findOwnMerchant(ctx, runtime, owner);
          if (!merchant) throw err;
        }
      }

      if (mode === 'embedded') {
        return {
          merchantAccount: merchantView(merchant),
          created,
          onboardingUrl: null,
          expiresAt: null,
        };
      }
      const link = await provider.createOnboardingLink({
        accountId: merchant.providerAccountId,
        returnUrl: config.urls.onboardingReturn,
        refreshUrl: config.urls.onboardingRefresh,
        collectEventuallyDue: config.onboarding.collect === 'eventually_due',
      });
      return {
        merchantAccount: merchantView(merchant),
        created,
        onboardingUrl: link.url,
        expiresAt: link.expiresAt.toISOString(),
      };
    },
  });

  function chooseDashboard(requested: MerchantDashboard | undefined): MerchantDashboard | null {
    if (requested) return requested;
    if (config.defaultDashboard) return config.defaultDashboard;
    const offered = Object.keys(config.dashboards) as MerchantDashboard[];
    return offered.length === 1 ? (offered[0] ?? null) : null;
  }

  const createMerchantSession = defineCapability({
    name: 'createMerchantSession',
    kind: 'action',
    domain: 'payments',
    description:
      "Mint a short-lived session for the provider's embeddable seller components (onboarding, payments, payouts, …)",
    input: z.object({ components: z.array(componentSchema).min(1).optional() }),
    output: z.object({
      clientSecret: z.string(),
      expiresAt: z.string(),
      publishableKey: z.string().nullable(),
      components: z.array(componentSchema),
    }),
    access: config.access.sellers,
    effects: { data: [], events: [], external: external(runtime), ai: false },
    async handler(ctx, input) {
      const { merchant } = await requireOwnMerchant(ctx, runtime);
      const components = input.components ?? defaultComponents(merchant);
      if (components.includes('onboarding') && !config.onboarding.modes.includes('embedded')) {
        throw ctx.errors.validation('Embedded onboarding is not enabled (onboarding.modes)', {
          reason: 'payments_onboarding_mode_disabled',
        });
      }
      const session = await provider.createMerchantSession({
        accountId: merchant.providerAccountId,
        components,
        allowRefunds: config.embedded.allowRefunds,
        allowDisputeManagement: config.embedded.allowDisputeManagement,
      });
      return {
        clientSecret: session.clientSecret,
        expiresAt: session.expiresAt.toISOString(),
        publishableKey: session.publishableKey,
        components,
      };
    },
  });

  function defaultComponents(merchant: PaymentMerchantAccountRow): MerchantComponent[] {
    const list: MerchantComponent[] = ['notifications', 'account'];
    if (config.onboarding.modes.includes('embedded')) list.unshift('onboarding');
    if (merchant.dashboard === 'none') list.push('payments', 'payouts', 'disputes');
    return list;
  }

  const getMerchantAccount = defineCapability({
    name: 'getMerchantAccount',
    kind: 'query',
    domain: 'payments',
    description: "Read the caller's seller account, or null when none is connected",
    input: z.object({}),
    output: z.object({ merchantAccount: merchantViewSchema.nullable() }),
    access: config.access.sellers,
    effects: { data: [PaymentEntityName.MerchantAccount], events: [], external: [], ai: false },
    async handler(ctx) {
      const owner = resolveOwner(ctx, runtime);
      const merchant = await findOwnMerchant(ctx, runtime, owner);
      return { merchantAccount: merchant ? merchantView(merchant) : null };
    },
  });

  const syncMerchantAccount = defineCapability({
    name: 'syncMerchantAccount',
    kind: 'action',
    domain: 'payments',
    description:
      "Pull the caller's seller account from the provider now (e.g. on the onboarding return page)",
    input: z.object({}),
    output: z.object({ merchantAccount: merchantViewSchema }),
    access: config.access.sellers,
    effects: {
      data: [PaymentEntityName.MerchantAccount],
      events: [PaymentEventName.MerchantUpdated],
      external: external(runtime),
      ai: false,
    },
    async handler(ctx) {
      const { merchant: before } = await requireOwnMerchant(ctx, runtime);
      const startedAt = ctx.time.now();
      const account = await provider.retrieveMerchantAccount(before.providerAccountId);
      // A webhook may have applied a newer read while this one was in flight.
      const merchant = (await merchantAccounts(ctx).findById(before.id)) ?? before;
      if (syncedAfter(merchant.syncedAt, startedAt)) {
        return { merchantAccount: merchantView(merchant) };
      }
      const status = deriveMerchantStatus(account);
      const changed = merchantChanged(merchant, account, status);
      const updated = await merchantAccounts(ctx).update(merchant.id, {
        status,
        chargesEnabled: account.chargesEnabled,
        payoutsEnabled: account.payoutsEnabled,
        requirementsDue: account.requirementsDue,
        requirementsPastDue: account.requirementsPastDue,
        disabledReason: account.disabledReason,
        syncedAt: startedAt,
      });
      if (changed) {
        await ctx.events.emit(PaymentEventName.MerchantUpdated, {
          merchantAccountId: merchant.id,
          ownerType: merchant.ownerType,
          ownerId: merchant.ownerId,
          status,
          previousStatus: merchant.status,
          chargesEnabled: account.chargesEnabled,
          payoutsEnabled: account.payoutsEnabled,
          requirementsDue: account.requirementsDue,
        });
      }
      return { merchantAccount: merchantView({ ...merchant, ...updated }) };
    },
  });

  const openMerchantDashboard = defineCapability({
    name: 'openMerchantDashboard',
    kind: 'action',
    domain: 'payments',
    description: "Return a link to the caller's provider dashboard (full or Express)",
    input: z.object({}),
    output: z.object({ url: z.string(), dashboard: dashboardSchema }),
    access: config.access.sellers,
    effects: { data: [], events: [], external: external(runtime), ai: false },
    async handler(ctx) {
      const { merchant } = await requireOwnMerchant(ctx, runtime);
      if (merchant.dashboard === 'none') {
        throw ctx.errors.conflict(
          'This seller has no provider dashboard; render createMerchantSession components instead',
          { reason: 'payments_no_dashboard' },
        );
      }
      const link = await provider.createDashboardLink({
        accountId: merchant.providerAccountId,
        dashboard: merchant.dashboard,
      });
      return { url: link.url, dashboard: merchant.dashboard };
    },
  });

  return {
    startMerchantOnboarding,
    createMerchantSession,
    getMerchantAccount,
    syncMerchantAccount,
    openMerchantDashboard,
  };
}
