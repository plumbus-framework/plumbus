import type { ChatPolicy, Guard } from '../types/policy.js';
import { actionGuard } from './action-guard.js';
import { audienceGuard } from './audience-guard.js';
import { behavioralPostGuard, behavioralPreGuard } from './behavioral-guard.js';
import { localeGuard } from './locale-guard.js';
import { privacyGuard } from './privacy-guard.js';
import { provenanceGuard } from './provenance-guard.js';
import { scopeClassifierGuard } from './scope-classifier.js';

export function compilePolicy(policy: ChatPolicy = {}): {
  preTurnGuards: Guard[];
  postTurnGuards: Guard[];
} {
  const preTurnGuards: Guard[] = [audienceGuard, localeGuard, behavioralPreGuard];
  const postTurnGuards: Guard[] = [
    provenanceGuard,
    scopeClassifierGuard,
    privacyGuard,
    actionGuard,
    behavioralPostGuard,
  ];
  if (policy.custom) {
    preTurnGuards.push(...policy.custom);
  }
  if (policy.customPostTurn) {
    postTurnGuards.push(...policy.customPostTurn);
  }
  return { preTurnGuards, postTurnGuards };
}
