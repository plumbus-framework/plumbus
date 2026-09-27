// Every payments capability, re-exported so discovery registers them (including
// the three system-only webhook capabilities the worker needs).
import { payments } from '../payments/index.js';

export const {
  startMerchantOnboarding,
  createMerchantSession,
  getMerchantAccount,
  syncMerchantAccount,
  openMerchantDashboard,
  createCharge,
  listCharges,
  getCharge,
  refundCharge,
  recordProviderEvent,
  processProviderEvent,
  applyProviderState,
} = payments.capabilities;
