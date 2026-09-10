/** Request admission primitives for capability-owned policy, before durable side effects. */
export { createRequestAdmission, withRequestAdmissionLock } from './request-admission.js';
export type { RequestAdmissionChallenge, RequestAdmissionProof } from './shared.js';
export { requestAdmissionChallengeSchema, requestAdmissionProofSchema } from './shared.js';
