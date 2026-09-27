import { randomBytes } from 'node:crypto';
import {
  AdminCreateUserCommand,
  type AdminCreateUserCommandOutput,
  AdminInitiateAuthCommand,
  type AdminInitiateAuthCommandOutput,
  AdminRespondToAuthChallengeCommand,
  type AdminRespondToAuthChallengeCommandOutput,
  AdminSetUserPasswordCommand,
  RevokeTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  type AttestationKey,
  signAttestation,
  validateAttestationKeys,
} from '../attestation/index.js';
import {
  assertUserPoolId,
  type CognitoConnectionOptions,
  cognitoUserPoolIssuer,
  openCognitoConnection,
} from './connection.js';
import { assertUsername, type CognitoPoolUser, cognitoPoolDirectoryOn } from './directory.js';
import { CognitoServerError, CognitoServerErrorReason } from './errors.js';
import { createCognitoIdTokenVerifier } from './tokens.js';

export interface CognitoPoolUsersOptions extends CognitoConnectionOptions {
  userPoolId: string;
  /** The pool's secretless app client, allowed `ALLOW_CUSTOM_AUTH`. */
  clientId: string;
  /** Keyring shared with the pool's attested sign-in trigger. The first key signs. */
  attestationKeys: readonly AttestationKey[];
  /** Non-fatal problems (a refresh token that could not be revoked). Default: ignored. */
  onWarning?: (message: string, detail: Readonly<Record<string, string>>) => void;
}

/** The identity a verified ID token asserts after an attested sign-in. */
export interface AttestedCognitoIdentity {
  issuer: string;
  subject: string;
  username: string;
  email?: string;
  emailVerified: boolean;
  authTime: Date;
  claims: Readonly<Record<string, unknown>>;
}

export type { CognitoPoolUser } from './directory.js';

export interface CognitoPoolUsers {
  readonly userPoolId: string;
  readonly issuer: string;
  getUser(username: string): Promise<CognitoPoolUser | null>;
  /**
   * Returns the user, creating it first if absent: admin-created, no Cognito message sent, email
   * marked verified, and a random permanent password nobody knows so its status is `CONFIRMED`.
   */
  ensureUser(input: {
    username: string;
    email?: string;
  }): Promise<CognitoPoolUser & { created: boolean }>;
  /** Signs the user in through custom auth with a server attestation and verifies the ID token. */
  signIn(input: {
    username: string;
    clientMetadata?: Readonly<Record<string, string>>;
  }): Promise<AttestedCognitoIdentity>;
  setUserEnabled(username: string, enabled: boolean): Promise<{ found: boolean }>;
  /** Replaces the email attribute and marks it verified. */
  updateEmail(username: string, email: string): Promise<void>;
}

const CUSTOM_CHALLENGE = 'CUSTOM_CHALLENGE';

/** A password that satisfies any Cognito policy and is never stored or shown. */
function unusablePassword(): string {
  return `${randomBytes(48).toString('base64url')}Aa1!`;
}

/** Server-side operations on one attested user pool. */
export function createCognitoPoolUsers(options: CognitoPoolUsersOptions): CognitoPoolUsers {
  assertUserPoolId(options.userPoolId);
  if (!options.clientId) throw new TypeError('clientId is required');
  const keys = validateAttestationKeys(options.attestationKeys);
  const { send } = openCognitoConnection(options);
  const { userPoolId, clientId } = options;
  const issuer = cognitoUserPoolIssuer(userPoolId, { endpoint: options.endpoint });
  const verifier = createCognitoIdTokenVerifier({ issuer, clientId });

  const directory = cognitoPoolDirectoryOn(send, userPoolId);
  const getUser = directory.getUser;

  async function confirm(username: string): Promise<void> {
    await send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: username,
        Password: unusablePassword(),
        Permanent: true,
      }),
    );
  }

  async function ensureUser(input: { username: string; email?: string }) {
    const existing = await getUser(input.username);
    if (existing) {
      // A create that crashed before its password was set leaves the user unconfirmed.
      if (existing.status === 'FORCE_CHANGE_PASSWORD') {
        await confirm(existing.username);
        return { ...existing, status: 'CONFIRMED', created: false };
      }
      return { ...existing, created: false };
    }
    let created = true;
    try {
      await send<AdminCreateUserCommandOutput>(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: input.username,
          MessageAction: 'SUPPRESS',
          TemporaryPassword: unusablePassword(),
          UserAttributes: input.email
            ? [
                { Name: 'email', Value: input.email },
                { Name: 'email_verified', Value: 'true' },
              ]
            : [],
        }),
      );
    } catch (error) {
      // Another request created it first; converge on that user.
      if ((error as CognitoServerError).cognitoError !== 'UsernameExistsException') throw error;
      created = false;
    }
    await confirm(input.username);
    const user = await getUser(input.username);
    if (!user) {
      throw new CognitoServerError(
        CognitoServerErrorReason.userNotFound,
        'user vanished right after creation',
      );
    }
    return { ...user, created };
  }

  async function revokeRefreshToken(token: string, username: string): Promise<void> {
    try {
      await send(new RevokeTokenCommand({ Token: token, ClientId: clientId }));
    } catch (error) {
      options.onWarning?.('Cognito refresh token was not revoked', {
        userPoolId,
        username,
        reason: (error as CognitoServerError).reason ?? 'unknown',
      });
    }
  }

  async function signIn(input: {
    username: string;
    clientMetadata?: Readonly<Record<string, string>>;
  }): Promise<AttestedCognitoIdentity> {
    assertUsername(input.username);
    const metadata = input.clientMetadata ? { ...input.clientMetadata } : undefined;
    const initiated = await send<AdminInitiateAuthCommandOutput>(
      new AdminInitiateAuthCommand({
        UserPoolId: userPoolId,
        ClientId: clientId,
        AuthFlow: 'CUSTOM_AUTH',
        AuthParameters: { USERNAME: input.username },
        ...(metadata ? { ClientMetadata: metadata } : {}),
      }),
    );
    const nonce = initiated.ChallengeParameters?.nonce;
    if (initiated.ChallengeName !== CUSTOM_CHALLENGE || !initiated.Session || !nonce) {
      throw new CognitoServerError(
        CognitoServerErrorReason.challengeRefused,
        `expected an attested custom challenge, got ${initiated.ChallengeName ?? 'tokens'}`,
      );
    }
    // Cognito names the user as it stores it; sign exactly what the verify trigger will see.
    const username = initiated.ChallengeParameters?.USERNAME ?? input.username;
    const answer = signAttestation(keys, { userPoolId, username, nonce });
    const responded = await send<AdminRespondToAuthChallengeCommandOutput>(
      new AdminRespondToAuthChallengeCommand({
        UserPoolId: userPoolId,
        ClientId: clientId,
        ChallengeName: CUSTOM_CHALLENGE,
        ChallengeResponses: { USERNAME: username, ANSWER: answer },
        Session: initiated.Session,
        ...(metadata ? { ClientMetadata: metadata } : {}),
      }),
    );
    const result = responded.AuthenticationResult;
    if (!result?.IdToken) {
      throw new CognitoServerError(
        CognitoServerErrorReason.challengeRefused,
        `Cognito issued no tokens (next challenge: ${responded.ChallengeName ?? 'none'})`,
      );
    }
    const claims = await verifier.verify(result.IdToken);
    const tokenUsername = claims['cognito:username'];
    if (
      typeof tokenUsername !== 'string' ||
      tokenUsername.toLowerCase() !== username.toLowerCase() ||
      typeof claims.sub !== 'string'
    ) {
      throw new CognitoServerError(
        CognitoServerErrorReason.tokenInvalid,
        'ID token names a different user than the one signed in',
      );
    }
    if (result.RefreshToken) await revokeRefreshToken(result.RefreshToken, username);
    const email = typeof claims.email === 'string' ? claims.email : undefined;
    const authTime = typeof claims.auth_time === 'number' ? claims.auth_time : claims.iat;
    return {
      issuer,
      subject: claims.sub,
      username: tokenUsername,
      ...(email ? { email } : {}),
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      authTime: new Date((authTime ?? 0) * 1000),
      claims: Object.freeze({ ...claims }),
    };
  }

  return Object.freeze({
    userPoolId,
    issuer,
    getUser,
    ensureUser,
    signIn,
    setUserEnabled: directory.setUserEnabled,
    updateEmail: directory.updateEmail,
  });
}
