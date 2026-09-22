import type { Guard } from '../types/policy.js';

export const scopeClassifierGuard: Guard = async (_turnCtx, state) => {
  const output = state.modelOutput;
  if (!output) return { decision: 'allow' };
  if (output.inScope !== false) return { decision: 'allow' };

  const reason = typeof output.refusalReason === 'string' ? output.refusalReason : 'off_topic';
  const key = `helpChat.error.outOfScope.${reason}`;
  let message = state.ctx.translations?.t(key) ?? 'This question is outside what I can help with.';
  if (message === key) {
    message = 'This question is outside what I can help with.';
  }

  return {
    decision: 'block',
    reason: 'out_of_scope',
    emit: { type: 'notice', code: 'chat.out_of_scope', message },
  };
};
