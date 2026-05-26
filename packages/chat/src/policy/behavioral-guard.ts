import type { Guard } from '../types/policy.js';
import { updateSessionBehavioralState, loadSession } from '../session/service.js';

export const behavioralPreGuard: Guard = async (turnCtx, state) => {
  const cooldowns = state.policy.behavioral?.cooldowns ?? [];
  if (cooldowns.length === 0) return { decision: 'allow' };

  // Ephemeral mode (`saveToDb: false`): no chat_session.behavioral_state to
  // read. Enforce cooldowns from clientHistory instead. Semantics: for each
  // refusal-trigger cooldown, look at the trailing assistant messages in
  // history — if the last N are ALL refusals (where N = cd.count), block
  // with the cooldown notice. The client also enforces a wall-clock cooldown
  // via the retryAfterSeconds hint; this server-side check is the
  // can't-be-bypassed defense even if the client clears localStorage.
  if (state.saveToDb === false) {
    const history = state.clientHistory ?? [];
    const assistants = history.filter((m) => m.role === 'assistant');
    for (const cd of cooldowns) {
      if (cd.trigger !== 'refusal') continue; // other triggers need DB
      if (assistants.length < cd.count) continue;
      const trailing = assistants.slice(-cd.count);
      const allRefusals = trailing.every((m) => m.refusalReason != null);
      if (allRefusals) {
        return {
          decision: 'block',
          reason: 'cooldown_active',
          emit: {
            type: 'notice',
            code: 'chat.cooldown_active',
            message: 'Cooldown active',
            retryAfterSeconds: cd.durationSeconds,
          },
        };
      }
    }
    return { decision: 'allow' };
  }

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

  // Ephemeral mode: nothing to persist. The refusal we just produced will be
  // sent back on next turn's clientHistory and re-detected by the pre-guard.
  if (state.saveToDb === false) return { decision: 'allow' };

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
