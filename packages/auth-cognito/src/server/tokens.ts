import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';
import { CognitoServerError, CognitoServerErrorReason } from './errors.js';

/** Verifies Cognito ID tokens of one pool and app client against the pool's JWKS. */
export interface CognitoIdTokenVerifier {
  verify(idToken: string): Promise<JWTPayload>;
}

export function createCognitoIdTokenVerifier(input: {
  issuer: string;
  clientId: string;
  /** Clock skew tolerance in seconds. Default 5. */
  clockToleranceSeconds?: number;
}): CognitoIdTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(`${input.issuer}/.well-known/jwks.json`), {
    timeoutDuration: 5000,
  });
  return {
    async verify(idToken) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(idToken, jwks, {
          issuer: input.issuer,
          audience: input.clientId,
          algorithms: ['RS256'],
          clockTolerance: input.clockToleranceSeconds ?? 5,
          requiredClaims: ['sub', 'iat', 'exp'],
        }));
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        // A JWKS that cannot be fetched is an outage, not a bad token.
        const reason =
          code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JOSE_GENERIC'
            ? CognitoServerErrorReason.providerUnavailable
            : CognitoServerErrorReason.tokenInvalid;
        throw new CognitoServerError(reason, 'Cognito ID token failed verification', {
          cause: error,
        });
      }
      if (payload.token_use !== 'id') {
        throw new CognitoServerError(
          CognitoServerErrorReason.tokenInvalid,
          'token is not a Cognito ID token',
        );
      }
      return payload;
    },
  };
}
