/**
 * Cognito custom-auth Lambda triggers for server-attested sign-in.
 *
 * Deploy `createAttestedSignInTrigger({ keys })` as one Lambda function and attach it as the user
 * pool's DefineAuthChallenge, CreateAuthChallenge and VerifyAuthChallengeResponse trigger. The
 * pool then issues tokens only to a caller holding the attestation keyring — the application
 * server using `@plumbus/auth-cognito/server`. No AWS SDK or JOSE dependency.
 */
export {
  CognitoTriggerSource,
  createAttestedChallenge,
  createAttestedSignInTrigger,
  defineAttestedChallenge,
  verifyAttestedChallenge,
} from './attested-sign-in.js';
export type {
  AttestationKeySource,
  AttestedSignInTriggerOptions,
  CognitoAuthChallengeEvent,
  CognitoChallengeResult,
} from './attested-sign-in.js';
export { parseAttestationKeys } from '../attestation/index.js';
export type { AttestationKey } from '../attestation/index.js';
