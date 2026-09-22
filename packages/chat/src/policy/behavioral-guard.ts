import type { Guard, GuardState } from '../types/policy.js';
import { resolveChatSessionStore } from '../session/session-store.js';

function cooldownScopeKey(
  cd: { scope?: 'session' | 'user' },
  turnCtx: { sessionId: string; userId: string },
) {
  const scope = cd.scope ?? 'session';
  return scope === 'user' ? `user:${turnCtx.userId}` : `session:${turnCtx.sessionId}`;
}

function usesUserScope(cooldowns: Array<{ scope?: 'session' | 'user' }>): boolean {
  return cooldowns.some((cd) => (cd.scope ?? 'session') === 'user');
}

function recordCooldownTrigger(
  bs: Record<string, unknown>,
  cd: {
    trigger: string;
    count: number;
    windowSeconds?: number;
    durationSeconds: number;
    scope?: 'session' | 'user';
  },
  turnCtx: { sessionId: string; userId: string },
  now: number,
): void {
  const key = `${cd.trigger}:${cooldownScopeKey(cd, turnCtx)}`;
  const entry = bs[key] as { count?: number; windowStart?: number } | undefined;
  const windowMs = (cd.windowSeconds ?? 0) * 1000;
  let count = entry?.count ?? 0;
  let windowStart = entry?.windowStart ?? now;
  if (windowMs > 0 && now - windowStart > windowMs) {
    count = 0;
    windowStart = now;
  }
  count += 1;
  bs[key] = { count, windowStart };
  if (count >= cd.count) {
    bs[`cooldown:${key}`] = { until: now + cd.durationSeconds * 1000 };
    bs[key] = { count: 0, windowStart: now };
  }
}

/** Session I/O for guards goes through the injected store when runChatTurn set one. */
function storeOf(state: GuardState) {
  return resolveChatSessionStore(state.sessionStore);
}

function pickUserScopedBehavioralKeys(state: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (key.includes(':user:')) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export const behavioralPreGuard: Guard = async (turnCtx, state) => {
  const cooldowns = state.policy.behavioral?.cooldowns ?? [];
  if (cooldowns.length === 0) return { decision: 'allow' };

  if (state.saveToDb === false) {
    const history = state.clientHistory ?? [];
    const assistants = history.filter((m) => m.role === 'assistant');
    for (const cd of cooldowns) {
      if (cd.trigger !== 'refusal') continue;
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

  const store = storeOf(state);
  const session = await store.loadSession(state.ctx, turnCtx.sessionId);
  if (!session) return { decision: 'allow' };

  // Session-local state first, then overlay fresher `*:user:*` keys from other
  // sessions so a stale local copy cannot defeat scope:'user' cooldowns.
  const bs = usesUserScope(cooldowns)
    ? {
        ...(session.behavioralState as Record<string, { until?: number }>),
        ...pickUserScopedBehavioralKeys(
          await store.loadMergedUserBehavioralState(state.ctx, turnCtx.userId),
        ),
      }
    : (session.behavioralState as Record<string, { until?: number }>);
  const now = Date.now();
  for (const key of Object.keys(bs)) {
    if (!key.startsWith('cooldown:')) continue;
    const entry = bs[key] as { until?: number };
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

  if (state.saveToDb === false) return { decision: 'allow' };

  const store = storeOf(state);
  const session = await store.loadSession(state.ctx, turnCtx.sessionId);
  if (!session) return { decision: 'allow' };

  const mergedUserState = usesUserScope(cooldowns)
    ? pickUserScopedBehavioralKeys(
        await store.loadMergedUserBehavioralState(state.ctx, turnCtx.userId),
      )
    : {};
  // Same precedence as pre-guard: fresher cross-session user keys override stale local copies.
  const bs = {
    ...(session.behavioralState as Record<string, unknown>),
    ...mergedUserState,
  };
  const output = state.modelOutput;
  const refused = output?.inScope === false;
  const now = Date.now();

  for (const cd of cooldowns) {
    if (cd.trigger === 'refusal' && !refused) continue;
    if (cd.trigger === 'guardFailure' && state.lastBudgetOrGuardSignal !== 'guardFailure') continue;
    if (cd.trigger === 'budget' && state.lastBudgetOrGuardSignal !== 'budget') continue;
    recordCooldownTrigger(bs, cd, turnCtx, now);
  }

  await store.updateSessionBehavioralState(state.ctx, turnCtx.sessionId, bs);
  return { decision: 'allow' };
};

/** Exported for run-turn per-turn budget breach accounting. */
export async function runBehavioralPostGuard(
  turnCtx: Parameters<Guard>[0],
  state: Parameters<Guard>[1],
): Promise<void> {
  await behavioralPostGuard(turnCtx, state);
}
