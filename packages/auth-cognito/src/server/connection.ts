import {
  CognitoIdentityProviderClient,
  type CognitoIdentityProviderClientConfig,
} from '@aws-sdk/client-cognito-identity-provider';
import { toCognitoServerError } from './errors.js';

/** How to reach Cognito. Credentials default to the AWS default provider chain. */
export interface CognitoConnectionOptions {
  /** AWS region of the pools this connection manages, e.g. `eu-west-1`. */
  region: string;
  /**
   * Override the Cognito endpoint — for `@plumbus/auth-cognito/testing` or a local emulator only.
   * When set, pool issuers are `<endpoint>/<userPoolId>` instead of the AWS IdP URL.
   */
  endpoint?: string;
  credentials?: CognitoIdentityProviderClientConfig['credentials'];
  /** Supply a preconfigured client (tests, custom middleware). `region`/`endpoint` still name issuers. */
  client?: CognitoIdentityProviderClient;
  /** SDK attempts per request, including the first. Default 2. */
  maxAttempts?: number;
  /** Per-request socket timeout. Default 5000 ms. */
  requestTimeoutMs?: number;
}

const POOL_ID_PATTERN = /^[\w-]+_[0-9a-zA-Z]+$/;

/** Checks a user pool id's shape (`<region>_<id>`). */
export function assertUserPoolId(userPoolId: string): void {
  if (!POOL_ID_PATTERN.test(userPoolId)) {
    throw new TypeError(`not a Cognito user pool id: ${JSON.stringify(userPoolId)}`);
  }
}

/** The region a user pool id names (`eu-west-1_AbC` → `eu-west-1`). */
export function regionOfUserPool(userPoolId: string): string {
  assertUserPoolId(userPoolId);
  return userPoolId.slice(0, userPoolId.lastIndexOf('_'));
}

/**
 * The OIDC issuer of a user pool: `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`, or
 * `<endpoint>/<userPoolId>` when an endpoint override is configured.
 */
export function cognitoUserPoolIssuer(
  userPoolId: string,
  options: { endpoint?: string } = {},
): string {
  assertUserPoolId(userPoolId);
  if (options.endpoint) return `${options.endpoint.replace(/\/+$/, '')}/${userPoolId}`;
  return `https://cognito-idp.${regionOfUserPool(userPoolId)}.amazonaws.com/${userPoolId}`;
}

/** Sends one SDK command, rethrowing every failure as a `CognitoServerError`. */
export type CognitoSend = <Output>(command: { resolveMiddleware: any }) => Promise<Output>;

export function openCognitoConnection(options: CognitoConnectionOptions): {
  client: CognitoIdentityProviderClient;
  send: CognitoSend;
} {
  if (!options.region) throw new TypeError('region is required');
  const client =
    options.client ??
    new CognitoIdentityProviderClient({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
      maxAttempts: options.maxAttempts ?? 2,
      requestHandler: { requestTimeout: options.requestTimeoutMs ?? 5000, connectionTimeout: 3000 },
    });
  const send: CognitoSend = async (command) => {
    try {
      return (await client.send(command as never)) as never;
    } catch (error) {
      throw toCognitoServerError(error);
    }
  };
  return { client, send };
}
