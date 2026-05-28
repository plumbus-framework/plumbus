import type { Guard } from '../types/policy.js';

export const privacyGuard: Guard = async (_turnCtx, state) => {
  const fields = state.policy.privacy?.redact ?? [];
  if (fields.length === 0 || !state.modelOutput) return { decision: 'allow' };

  let answer = typeof state.modelOutput.answer === 'string' ? state.modelOutput.answer : '';
  for (const field of fields) {
    answer = answer.split(field).join('[redacted]');
  }
  state.modelOutput.answer = answer;
  return { decision: 'allow' };
};
