/**
 * Server-side Amazon Cognito for passwordless apps: attested sign-in, user lifecycle, and
 * pool administration.
 *
 * The application authenticates the person itself (a magic link, a passkey), then signs them
 * into their Cognito user through custom auth, answering the pool trigger's nonce with an HMAC
 * attestation (`@plumbus/auth-cognito/triggers`). Cognito stays the user directory and token
 * issuer; no hosted UI, no passwords, no Cognito-sent mail. Node only; uses the AWS SDK.
 */
export {
  assertUserPoolId,
  cognitoUserPoolIssuer,
  regionOfUserPool,
} from './connection.js';
export type { CognitoConnectionOptions } from './connection.js';
export { CognitoServerError, CognitoServerErrorReason, toCognitoServerError } from './errors.js';
export { createCognitoPoolDirectory } from './directory.js';
export type { CognitoPoolDirectory, CognitoPoolDirectoryOptions } from './directory.js';
export { createCognitoPoolAdministration } from './pools.js';
export type {
  AttestedUserPoolSpec,
  CognitoMfaPolicy,
  CognitoPoolAdministration,
  EnsuredAttestedUserPool,
} from './pools.js';
export { createCognitoIdTokenVerifier } from './tokens.js';
export type { CognitoIdTokenVerifier } from './tokens.js';
export { createCognitoPoolUsers } from './users.js';
export type {
  AttestedCognitoIdentity,
  CognitoPoolUser,
  CognitoPoolUsers,
  CognitoPoolUsersOptions,
} from './users.js';
export { parseAttestationKeys, validateAttestationKeys } from '../attestation/index.js';
export type { AttestationKey } from '../attestation/index.js';
