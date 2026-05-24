import type { Guard } from '../types/policy.js';
import { updateSessionBehavioralState, loadSession } from '../session/service.js';

export const behavioralPreGuard: Guard = async (turnCtx, state) => {
  const cooldowns = state.policy.behavioral?.cooldowns ?? [];
  if (cooldowns.length === 0) return { decision: 'allow' };

  const session = await loadSession(state.ctx, turnCtx.sessionId);
  if (!session) return { decision: 'allow' };

  const bs = session.behavioralState as Record<string, { until?: number }>;
  const now = Date.now();
  for (const key of Object.keys(bs)) {
    const entry = bs[key];
    if (entry?.until && entry.until > now) {
      const retryAfter = Math.ceil((entry.until - now) / 1000);
      return {
        decision: 'block',
        reason: 'cooldown_active',
        emit: {
          type: 'notice',
          code: 'chat.cooldown_active',
          message: 'Cooldown active',
          retryAfterSeconds: retryAfter,
        },
      };
    }
  }
  return { decision: 'allow' };
};

export const behavioralPostGuard: Guard = async (turnCtx, state) => {
  const cooldowns = state.policy.behavioral?.cooldowns ?? [];
  if (cooldowns.length === 0) return { decision: 'allow' };

  const session = await loadSession(state.ctx, turnCtx.sessionId);
  if (!session) return { decision: 'allow' };

  const bs = { ...(session.behavioralState as Record<string, unknown>) };
  const output = state.modelOutput;
  const refused = output?.inScope === false;

  for (const cd of cooldowns) {
    if (cd.trigger === 'refusal' && !refused) continue;
    const key = `${cd.trigger}:${cd.scope ?? 'session'}`;
    const prev = (bs[key] as { count?: number })?.count ?? 0;
    const count = prev + 1;
    bs[key] = { count };
    if (count >= cd.count) {
      bs[`cooldown:${key}`] = { until: Date.now() + cd.durationSeconds * 1000 };
      bs[key] = { count: 0 };
    }
  }

  await updateSessionBehavioralState(state.ctx, turnCtx.sessionId, bs);
  return { decision: 'allow' };
};
