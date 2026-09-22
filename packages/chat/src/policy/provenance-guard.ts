import { stripInvalidFromAnswer, validateCitations } from '../runtime/provenance.js';
import type { Guard } from '../types/policy.js';

export const provenanceGuard: Guard = async (_turnCtx, state) => {
  const output = state.modelOutput;
  if (!output) return { decision: 'allow' };

  const cited = Array.isArray(output.citedSources) ? (output.citedSources as string[]) : [];
  const allowed = state.resolvedSources ?? new Set<string>();
  const { valid, invalid } = validateCitations(cited, allowed);

  if (typeof output.answer === 'string') {
    output.answer = stripInvalidFromAnswer(output.answer, invalid);
  }

  if (state.policy.provenance?.required && valid.length === 0) {
    return {
      decision: 'block',
      reason: 'provenance_missing',
      emit: {
        type: 'notice',
        code: 'chat.provenance_missing',
        message: 'Response missing required sources',
      },
    };
  }

  const minSources = state.policy.provenance?.minSources;
  if (minSources !== undefined && valid.length < minSources) {
    return {
      decision: 'block',
      reason: 'provenance_insufficient',
      emit: {
        type: 'notice',
        code: 'chat.provenance_insufficient',
        message: `Response cited fewer than ${minSources} required sources`,
      },
    };
  }

  return { decision: 'allow' };
};
