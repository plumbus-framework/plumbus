/**
 * Server attestation for Cognito custom authentication.
 *
 * The application server proves to the user pool's verify trigger that it has already
 * authenticated a person (for example by a magic link): it answers the trigger's nonce with an
 * HMAC under a keyring the server and the trigger share. Shared by `./server` (signs) and
 * `./triggers` (verifies); dependency-free so the trigger bundle stays small.
 */
export {
  ATTESTATION_CHALLENGE_METADATA,
  createAttestationNonce,
  parseAttestationKeys,
  signAttestation,
  validateAttestationKeys,
  verifyAttestation,
} from './attestation.js';
export type { AttestationKey, AttestationSubject } from './attestation.js';
