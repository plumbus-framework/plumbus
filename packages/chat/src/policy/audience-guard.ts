import type { Guard } from '../types/policy.js';

export const audienceGuard: Guard = async (turnCtx, state) => {
  const aud = state.policy.audience;
  if (!aud) return { decision: 'allow' };
  const mode = aud.mode ?? 'strict';
  if (mode === 'permissive') return { decision: 'allow' };
  const ok = aud.roles.includes(turnCtx.audience) && state.ctx.security.hasRole(turnCtx.audience);
  if (!ok) {
    return {
      decision: 'block',
      reason: 'audience_mismatch',
      emit: { type: 'notice', code: 'chat.audience_denied', message: 'Audience not permitted' },
    };
  }
  return { decision: 'allow' };
};
