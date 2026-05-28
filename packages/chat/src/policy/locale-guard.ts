import type { Guard } from '../types/policy.js';

export const localeGuard: Guard = async (turnCtx, state) => {
  const allowed = state.policy.scope?.locales;
  if (!allowed || allowed.length === 0) return { decision: 'allow' };
  if (!allowed.includes(turnCtx.locale)) {
    return {
      decision: 'block',
      reason: 'locale_not_allowed',
      emit: { type: 'notice', code: 'chat.locale_denied', message: 'Locale not supported' },
    };
  }
  return { decision: 'allow' };
};
