/**
 * Test utilities for `@plumbus/auth-cognito`: an in-process fake Cognito user-pool service.
 *
 * `startFakeCognito()` answers the AWS SDK (endpoint override) for the actions
 * `@plumbus/auth-cognito/server` uses, runs the attested custom-auth trigger in-process, and
 * serves per-pool JWKS, OIDC discovery and a minimal hosted login for `@plumbus/auth`. For tests
 * and local development only; never point production at it.
 */
export { startFakeCognito } from './fake-cognito.js';
export type {
  FakeCognito,
  FakeCognitoCall,
  FakeCognitoDelivery,
  FakeCognitoOptions,
  FakeCognitoPool,
  FakeCognitoUser,
} from './fake-cognito.js';
