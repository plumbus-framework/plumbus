import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import type { AttestationKey } from '../attestation/index.js';
import {
  type CognitoAuthChallengeEvent,
  type CognitoChallengeResult,
  CognitoTriggerSource,
  createAttestedSignInTrigger,
} from '../triggers/index.js';

type Trigger = (event: CognitoAuthChallengeEvent) => Promise<CognitoAuthChallengeEvent>;

export interface FakeCognitoOptions {
  /** Region in generated pool ids. Default `eu-west-1`. */
  region?: string;
  /**
   * Port to listen on. Default 0 (any free port). Fix it when issuers must stay stable across
   * restarts — for example a dev stack whose stored identity links name `<endpoint>/<poolId>`.
   */
  port?: number;
  /** Interface to bind. Default `127.0.0.1`; the endpoint uses `127.0.0.1` for `0.0.0.0`/`::`. */
  host?: string;
  /** Keyring for the built-in attested sign-in trigger (the real `createAttestedSignInTrigger`). */
  attestationKeys?: readonly AttestationKey[];
  /** A custom trigger instead of the attested one; runs for every pool with triggers configured. */
  trigger?: Trigger;
}

export interface FakeCognitoUser {
  username: string;
  subject: string;
  enabled: boolean;
  status: string;
  attributes: Readonly<Record<string, string>>;
}

export interface FakeCognitoPool {
  id: string;
  name: string;
  tags: Readonly<Record<string, string>>;
  deletionProtection: string;
  allowAdminCreateUserOnly: boolean;
  lambdaConfig: Readonly<Record<string, string>>;
}

export interface FakeCognitoDelivery {
  username: string;
  email: string;
  kind: 'invitation' | 'resend';
}

export interface FakeCognitoCall {
  action: string;
  input: Readonly<Record<string, unknown>>;
}

export interface FakeCognito {
  /** Base URL: pass as the SDK `endpoint` and as the server module's `endpoint`. */
  readonly endpoint: string;
  readonly region: string;
  readonly credentials: { accessKeyId: string; secretAccessKey: string };
  /** `{ region, endpoint, credentials }` — spread into connection options. */
  readonly clientConfig: {
    region: string;
    endpoint: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
  };
  /** Every JSON API call received, in order. */
  readonly calls: readonly FakeCognitoCall[];
  issuerFor(userPoolId: string): string;
  pools(): readonly FakeCognitoPool[];
  users(userPoolId: string): readonly FakeCognitoUser[];
  /**
   * Invitation emails Cognito would have sent (`AdminCreateUser` without `SUPPRESS`, and
   * `RESEND`), in order. The temporary password is never modelled.
   */
  deliveries(userPoolId: string): readonly FakeCognitoDelivery[];
  /** Refresh tokens issued by a pool and whether each was revoked. */
  refreshTokens(userPoolId: string): readonly { username: string; revoked: boolean }[];
  /** The user the pool's hosted login signs in (authorize auto-approves them). */
  setHostedLoginUser(userPoolId: string, username: string): void;
  /** Marks a user as federated: their ID tokens carry an `identities` claim. */
  markFederated(userPoolId: string, username: string, providerName: string): void;
  /** Every call to `action` fails with `errorName` until `clearFailures()`. */
  failAction(action: string, errorName?: string): void;
  clearFailures(): void;
  /** Query parameters of the last hosted-login authorize request, per pool. */
  lastAuthorizeParams(userPoolId: string): Readonly<Record<string, string>> | null;
  close(): Promise<void>;
}

interface UserState {
  username: string;
  sub: string;
  attributes: Map<string, string>;
  enabled: boolean;
  status: string;
  createdAt: number;
  identities?: Record<string, unknown>[];
}

interface ClientState {
  id: string;
  name: string;
  secret?: string;
  explicitAuthFlows: string[];
  callbackUrls: string[];
  logoutUrls: string[];
  allowedOAuthFlows: string[];
  allowedOAuthScopes: string[];
  allowedOAuthFlowsUserPoolClient: boolean;
  supportedIdentityProviders: string[];
  preventUserExistenceErrors: string;
  idTokenValidityMinutes: number;
  raw: Record<string, unknown>;
}

interface PoolState {
  id: string;
  name: string;
  createdAt: number;
  tags: Record<string, string>;
  lambdaConfig: Record<string, string>;
  allowAdminCreateUserOnly: boolean;
  recovery: unknown[];
  caseSensitive: boolean;
  /** `UsernameAttributes`: with `email`, a user created by address gets a UUID username. */
  usernameAttributes: string[];
  deletionProtection: string;
  mfa: string;
  softwareToken: boolean;
  sms: boolean;
  email: boolean;
  policies: Record<string, unknown>;
  users: Map<string, UserState>;
  clients: Map<string, ClientState>;
  kid: string;
  privateKey: CryptoKey;
  jwk: JWK;
  hostedLoginUser?: string;
  lastAuthorize: Record<string, string> | null;
}

interface AuthSession {
  poolId: string;
  clientId: string;
  username: string;
  session: CognitoChallengeResult[];
  privateParameters: Record<string, string>;
  challengeMetadata?: string;
  expiresAt: number;
}

interface CodeState {
  poolId: string;
  clientId: string;
  username: string;
  redirectUri: string;
  nonce?: string;
  codeChallenge?: string;
  scope: string;
  authTime: number;
}

class FakeError extends Error {
  constructor(
    readonly type: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const SERVER_FAULTS = new Set(['InternalErrorException', 'ServiceUnavailable']);
const DEFAULT_RECOVERY = [
  { Name: 'verified_email', Priority: 1 },
  { Name: 'verified_phone_number', Priority: 2 },
];

function randomAlnum(length: number, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += alphabet[(bytes[index] ?? 0) % alphabet.length];
  }
  return out;
}

function seconds(): number {
  return Math.floor(Date.now() / 1000);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  type = 'application/x-amz-json-1.1',
): void {
  response.writeHead(status, { 'content-type': type });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, error: FakeError): void {
  response.writeHead(error.status, {
    'content-type': 'application/x-amz-json-1.1',
    'x-amzn-errortype': error.type,
  });
  response.end(JSON.stringify({ __type: error.type, message: error.message }));
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location });
  response.end();
}

/**
 * An in-process Amazon Cognito user-pool service for tests and local development.
 *
 * Speaks the Cognito JSON API to the real AWS SDK (point `endpoint` at it) for the actions the
 * server module uses, runs custom-auth triggers in-process (the real attested trigger by default),
 * serves per-pool JWKS and OIDC discovery at `<endpoint>/<poolId>`, and a minimal hosted login
 * (authorize with PKCE, token with client secret) so `@plumbus/auth` can sign in against a pool.
 * Not a general Cognito emulator: unknown actions answer `InvalidParameterException`.
 */
export async function startFakeCognito(options: FakeCognitoOptions = {}): Promise<FakeCognito> {
  const region = options.region ?? 'eu-west-1';
  const trigger: Trigger | undefined =
    options.trigger ??
    (options.attestationKeys
      ? createAttestedSignInTrigger({ keys: options.attestationKeys })
      : undefined);
  const pools = new Map<string, PoolState>();
  const sessions = new Map<string, AuthSession>();
  const codes = new Map<string, CodeState>();
  const refreshTokens = new Map<
    string,
    { poolId: string; clientId: string; username: string; revoked: boolean }
  >();
  const accessTokens = new Map<string, { poolId: string; username: string }>();
  const failures = new Map<string, string>();
  const deliveries: Array<FakeCognitoDelivery & { poolId: string }> = [];
  const calls: FakeCognitoCall[] = [];
  let endpoint = '';
  const credentials = { accessKeyId: 'fake-access-key', secretAccessKey: 'fake-secret-key' };

  const issuerFor = (poolId: string) => `${endpoint}/${poolId}`;

  function pool(id: unknown): PoolState {
    const found = pools.get(str(id));
    if (!found)
      throw new FakeError('ResourceNotFoundException', `User pool ${str(id)} does not exist.`);
    return found;
  }

  function client(state: PoolState, id: unknown): ClientState {
    const found = state.clients.get(str(id));
    if (!found)
      throw new FakeError(
        'ResourceNotFoundException',
        `User pool client ${str(id)} does not exist.`,
      );
    return found;
  }

  function userKey(state: PoolState, username: string): string {
    return state.caseSensitive ? username : username.toLowerCase();
  }

  function findUser(state: PoolState, username: unknown): UserState | undefined {
    const direct = state.users.get(userKey(state, str(username)));
    if (direct || !state.usernameAttributes.includes('email')) return direct;
    // An email-as-username pool answers to the address as well as to the username.
    const address = str(username).toLowerCase();
    return [...state.users.values()].find(
      (entry) => (entry.attributes.get('email') ?? '').toLowerCase() === address,
    );
  }

  function user(state: PoolState, username: unknown): UserState {
    const found = findUser(state, username);
    if (!found) throw new FakeError('UserNotFoundException', 'User does not exist.');
    return found;
  }

  function describePool(state: PoolState) {
    return {
      Id: state.id,
      Name: state.name,
      Arn: `arn:aws:cognito-idp:${region}:000000000000:userpool/${state.id}`,
      CreationDate: state.createdAt,
      LastModifiedDate: state.createdAt,
      LambdaConfig: { ...state.lambdaConfig },
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: state.allowAdminCreateUserOnly },
      AccountRecoverySetting: { RecoveryMechanisms: state.recovery },
      UsernameConfiguration: { CaseSensitive: state.caseSensitive },
      DeletionProtection: state.deletionProtection,
      MfaConfiguration: state.mfa,
      Policies: state.policies,
      UserPoolTags: { ...state.tags },
      EstimatedNumberOfUsers: state.users.size,
    };
  }

  function describeClient(state: PoolState, entry: ClientState) {
    return {
      ...entry.raw,
      UserPoolId: state.id,
      ClientId: entry.id,
      ClientName: entry.name,
      ...(entry.secret ? { ClientSecret: entry.secret } : {}),
    };
  }

  function projectUser(entry: UserState) {
    return {
      Username: entry.username,
      Enabled: entry.enabled,
      UserStatus: entry.status,
      UserCreateDate: entry.createdAt,
      UserLastModifiedDate: entry.createdAt,
    };
  }

  function userAttributes(entry: UserState) {
    return [
      { Name: 'sub', Value: entry.sub },
      ...[...entry.attributes.entries()].map(([Name, Value]) => ({ Name, Value })),
    ];
  }

  function applyAttributes(entry: UserState, attributes: unknown): void {
    if (!Array.isArray(attributes)) return;
    for (const attribute of attributes as { Name?: unknown; Value?: unknown }[]) {
      const name = str(attribute.Name);
      if (!name || name === 'sub') continue;
      entry.attributes.set(name, str(attribute.Value));
    }
  }

  async function runTrigger(event: CognitoAuthChallengeEvent): Promise<CognitoAuthChallengeEvent> {
    if (!trigger)
      throw new FakeError('UnexpectedLambdaException', 'No trigger is configured in the fake.');
    try {
      return await trigger(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'error';
      throw new FakeError(
        'UserLambdaValidationException',
        `CustomAuthChallenge failed with error ${message}.`,
      );
    }
  }

  function triggerEvent(
    state: PoolState,
    triggerSource: string,
    username: string,
    request: CognitoAuthChallengeEvent['request'],
  ): CognitoAuthChallengeEvent {
    return {
      version: '1',
      region,
      triggerSource,
      userPoolId: state.id,
      userName: username,
      callerContext: { awsSdkVersion: 'fake', clientId: '' },
      request,
      response: {},
    };
  }

  async function signToken(
    state: PoolState,
    claims: Record<string, unknown>,
    expiresInSeconds: number,
  ): Promise<string> {
    const now = seconds();
    return new SignJWT({ ...claims, iat: now, exp: now + expiresInSeconds, jti: randomUUID() })
      .setProtectedHeader({ alg: 'RS256', kid: state.kid })
      .sign(state.privateKey);
  }

  async function issueTokens(
    state: PoolState,
    entry: ClientState,
    subject: UserState,
    extra: { nonce?: string; authTime?: number; scope?: string } = {},
  ) {
    const email = subject.attributes.get('email');
    const idToken = await signToken(
      state,
      {
        sub: subject.sub,
        iss: issuerFor(state.id),
        aud: entry.id,
        token_use: 'id',
        auth_time: extra.authTime ?? seconds(),
        'cognito:username': subject.username,
        origin_jti: randomUUID(),
        event_id: randomUUID(),
        ...(email ? { email } : {}),
        ...(subject.attributes.has('email_verified')
          ? { email_verified: subject.attributes.get('email_verified') === 'true' }
          : {}),
        ...(subject.identities ? { identities: subject.identities } : {}),
        ...(extra.nonce ? { nonce: extra.nonce } : {}),
      },
      entry.idTokenValidityMinutes * 60,
    );
    const accessToken = await signToken(
      state,
      {
        sub: subject.sub,
        iss: issuerFor(state.id),
        client_id: entry.id,
        token_use: 'access',
        scope: extra.scope ?? 'aws.cognito.signin.user.admin',
        username: subject.username,
      },
      300,
    );
    const refreshToken = randomBytes(32).toString('base64url');
    refreshTokens.set(refreshToken, {
      poolId: state.id,
      clientId: entry.id,
      username: subject.username,
      revoked: false,
    });
    accessTokens.set(accessToken, { poolId: state.id, username: subject.username });
    return { idToken, accessToken, refreshToken };
  }

  async function challengeOrTokens(
    auth: AuthSession,
    state: PoolState,
    entry: ClientState,
    subject: UserState,
  ) {
    const defined = await runTrigger(
      triggerEvent(state, CognitoTriggerSource.define, subject.username, {
        userAttributes: Object.fromEntries(subject.attributes),
        session: auth.session,
        userNotFound: false,
      }),
    );
    const response = defined.response;
    if (response.failAuthentication === true) {
      throw new FakeError('NotAuthorizedException', 'Incorrect username or password.');
    }
    if (response.issueTokens === true) {
      if (subject.status === 'FORCE_CHANGE_PASSWORD') {
        const next = randomBytes(24).toString('base64url');
        sessions.set(next, { ...auth, expiresAt: Date.now() + 180_000 });
        return {
          ChallengeName: 'NEW_PASSWORD_REQUIRED',
          Session: next,
          ChallengeParameters: { USER_ID_FOR_SRP: subject.username },
        };
      }
      const tokens = await issueTokens(state, entry, subject);
      return {
        ChallengeParameters: {},
        AuthenticationResult: {
          IdToken: tokens.idToken,
          AccessToken: tokens.accessToken,
          RefreshToken: tokens.refreshToken,
          ExpiresIn: 300,
          TokenType: 'Bearer',
        },
      };
    }
    const challengeName = str(response.challengeName);
    const created = await runTrigger(
      triggerEvent(state, CognitoTriggerSource.create, subject.username, {
        userAttributes: Object.fromEntries(subject.attributes),
        challengeName,
        session: auth.session,
      }),
    );
    const publicParameters = (created.response.publicChallengeParameters ?? {}) as Record<
      string,
      string
    >;
    const token = randomBytes(24).toString('base64url');
    sessions.set(token, {
      ...auth,
      privateParameters: (created.response.privateChallengeParameters ?? {}) as Record<
        string,
        string
      >,
      challengeMetadata: str(created.response.challengeMetadata) || undefined,
      expiresAt: Date.now() + 180_000,
    });
    return {
      ChallengeName: challengeName,
      Session: token,
      ChallengeParameters: { USERNAME: subject.username, ...publicParameters },
    };
  }

  const actions: Record<string, (input: Record<string, any>) => Promise<unknown> | unknown> = {
    async CreateUserPool(input) {
      const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
      const kid = randomAlnum(16);
      const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
      const id = `${region}_${randomAlnum(9, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')}`;
      const state: PoolState = {
        id,
        name: str(input.PoolName),
        createdAt: seconds(),
        tags: { ...(input.UserPoolTags ?? {}) },
        lambdaConfig: { ...(input.LambdaConfig ?? {}) },
        allowAdminCreateUserOnly: input.AdminCreateUserConfig?.AllowAdminCreateUserOnly === true,
        recovery: input.AccountRecoverySetting?.RecoveryMechanisms ?? DEFAULT_RECOVERY,
        caseSensitive: input.UsernameConfiguration?.CaseSensitive !== false,
        usernameAttributes: list(input.UsernameAttributes),
        deletionProtection: str(input.DeletionProtection) || 'INACTIVE',
        mfa: str(input.MfaConfiguration) || 'OFF',
        softwareToken: false,
        sms: false,
        email: false,
        policies: input.Policies ?? {},
        users: new Map(),
        clients: new Map(),
        kid,
        privateKey,
        jwk,
        lastAuthorize: null,
      };
      if (!state.name) throw new FakeError('InvalidParameterException', 'PoolName is required.');
      pools.set(id, state);
      return { UserPool: describePool(state) };
    },
    DescribeUserPool: (input) => ({ UserPool: describePool(pool(input.UserPoolId)) }),
    ListUserPools(input) {
      const max = Number(input.MaxResults ?? 0);
      if (!(max >= 1 && max <= 60))
        throw new FakeError('InvalidParameterException', 'MaxResults must be 1-60.');
      const all = [...pools.values()];
      const start = Number(input.NextToken ?? 0);
      const page = all.slice(start, start + max);
      return {
        UserPools: page.map((entry) => ({
          Id: entry.id,
          Name: entry.name,
          CreationDate: entry.createdAt,
        })),
        ...(start + max < all.length ? { NextToken: String(start + max) } : {}),
      };
    },
    UpdateUserPool(input) {
      const state = pool(input.UserPoolId);
      // Cognito resets every omitted setting to its default; mirror that so callers must restate.
      state.lambdaConfig = { ...(input.LambdaConfig ?? {}) };
      state.allowAdminCreateUserOnly =
        input.AdminCreateUserConfig?.AllowAdminCreateUserOnly === true;
      state.recovery = input.AccountRecoverySetting?.RecoveryMechanisms ?? DEFAULT_RECOVERY;
      state.deletionProtection = str(input.DeletionProtection) || 'INACTIVE';
      state.mfa = str(input.MfaConfiguration) || 'OFF';
      state.policies = input.Policies ?? {};
      if (input.UserPoolTags) state.tags = { ...input.UserPoolTags };
      return {};
    },
    DeleteUserPool(input) {
      const state = pool(input.UserPoolId);
      if (state.deletionProtection === 'ACTIVE') {
        throw new FakeError(
          'InvalidParameterException',
          'The user pool cannot be deleted because deletion protection is activated.',
        );
      }
      pools.delete(state.id);
      return {};
    },
    SetUserPoolMfaConfig(input) {
      const state = pool(input.UserPoolId);
      if (input.MfaConfiguration) state.mfa = str(input.MfaConfiguration);
      if (input.SoftwareTokenMfaConfiguration) {
        state.softwareToken = input.SoftwareTokenMfaConfiguration.Enabled === true;
      }
      if (input.SmsMfaConfiguration)
        state.sms = input.SmsMfaConfiguration.SmsConfiguration !== undefined;
      if (input.EmailMfaConfiguration) state.email = true;
      return {
        MfaConfiguration: state.mfa,
        SoftwareTokenMfaConfiguration: { Enabled: state.softwareToken },
      };
    },
    GetUserPoolMfaConfig(input) {
      const state = pool(input.UserPoolId);
      return {
        MfaConfiguration: state.mfa,
        SoftwareTokenMfaConfiguration: { Enabled: state.softwareToken },
        ...(state.sms
          ? {
              SmsMfaConfiguration: {
                SmsConfiguration: { SnsCallerArn: 'arn:aws:iam::000000000000:role/fake-sms' },
              },
            }
          : {}),
        ...(state.email ? { EmailMfaConfiguration: { Subject: 'code', Message: '{####}' } } : {}),
      };
    },
    ListUserPoolClients(input) {
      const state = pool(input.UserPoolId);
      return {
        UserPoolClients: [...state.clients.values()].map((entry) => ({
          ClientId: entry.id,
          ClientName: entry.name,
          UserPoolId: state.id,
        })),
      };
    },
    CreateUserPoolClient(input) {
      const state = pool(input.UserPoolId);
      const units = (input.TokenValidityUnits ?? {}) as Record<string, string>;
      const idValidity = Number(input.IdTokenValidity ?? 60);
      const entry: ClientState = {
        id: randomAlnum(26),
        name: str(input.ClientName),
        ...(input.GenerateSecret === true ? { secret: randomAlnum(51) } : {}),
        explicitAuthFlows: list(input.ExplicitAuthFlows),
        callbackUrls: list(input.CallbackURLs),
        logoutUrls: list(input.LogoutURLs),
        allowedOAuthFlows: list(input.AllowedOAuthFlows),
        allowedOAuthScopes: list(input.AllowedOAuthScopes),
        allowedOAuthFlowsUserPoolClient: input.AllowedOAuthFlowsUserPoolClient === true,
        supportedIdentityProviders: list(input.SupportedIdentityProviders),
        preventUserExistenceErrors: str(input.PreventUserExistenceErrors) || 'LEGACY',
        idTokenValidityMinutes:
          units.IdToken === 'hours' || !units.IdToken ? idValidity * 60 : idValidity,
        raw: { ...input },
      };
      delete entry.raw.UserPoolId;
      state.clients.set(entry.id, entry);
      return { UserPoolClient: describeClient(state, entry) };
    },
    DescribeUserPoolClient(input) {
      const state = pool(input.UserPoolId);
      return { UserPoolClient: describeClient(state, client(state, input.ClientId)) };
    },
    AdminCreateUser(input) {
      const state = pool(input.UserPoolId);
      const username = str(input.Username);
      if (!username) throw new FakeError('InvalidParameterException', 'Username is required.');
      if (input.MessageAction === 'RESEND') {
        const existing = user(state, username);
        if (existing.status !== 'FORCE_CHANGE_PASSWORD') {
          throw new FakeError(
            'UnsupportedUserStateException',
            'User is not in FORCE_CHANGE_PASSWORD state.',
          );
        }
        deliveries.push({
          poolId: state.id,
          username: existing.username,
          email: existing.attributes.get('email') ?? '',
          kind: 'resend',
        });
        return { User: { ...projectUser(existing), Attributes: userAttributes(existing) } };
      }
      if (findUser(state, username)) {
        throw new FakeError('UsernameExistsException', 'User account already exists.');
      }
      const sub = randomUUID();
      const byAddress = state.usernameAttributes.includes('email') && username.includes('@');
      const entry: UserState = {
        username: byAddress ? sub : username,
        sub,
        attributes: new Map(),
        enabled: true,
        status: 'FORCE_CHANGE_PASSWORD',
        createdAt: seconds(),
      };
      applyAttributes(entry, input.UserAttributes);
      if (byAddress && !entry.attributes.has('email')) entry.attributes.set('email', username);
      state.users.set(userKey(state, entry.username), entry);
      if (input.MessageAction !== 'SUPPRESS') {
        deliveries.push({
          poolId: state.id,
          username: entry.username,
          email: entry.attributes.get('email') ?? '',
          kind: 'invitation',
        });
      }
      return { User: { ...projectUser(entry), Attributes: userAttributes(entry) } };
    },
    ListUsers(input) {
      const state = pool(input.UserPoolId);
      const limit = Number(input.Limit ?? 60);
      if (!(limit >= 1 && limit <= 60)) {
        throw new FakeError('InvalidParameterException', 'Limit must be 1-60.');
      }
      const all = [...state.users.values()];
      const start = Number(input.PaginationToken ?? 0);
      const page = all.slice(start, start + limit);
      return {
        Users: page.map((entry) => ({ ...projectUser(entry), Attributes: userAttributes(entry) })),
        ...(start + limit < all.length ? { PaginationToken: String(start + limit) } : {}),
      };
    },
    AdminGetUser(input) {
      const entry = user(pool(input.UserPoolId), input.Username);
      return { ...projectUser(entry), UserAttributes: userAttributes(entry) };
    },
    AdminSetUserPassword(input) {
      const state = pool(input.UserPoolId);
      const entry = user(state, input.Username);
      const minimum = Number(
        (state.policies.PasswordPolicy as { MinimumLength?: number } | undefined)?.MinimumLength ??
          8,
      );
      if (str(input.Password).length < minimum) {
        throw new FakeError('InvalidPasswordException', 'Password does not conform to policy.');
      }
      entry.status = input.Permanent === true ? 'CONFIRMED' : 'FORCE_CHANGE_PASSWORD';
      return {};
    },
    AdminEnableUser(input) {
      user(pool(input.UserPoolId), input.Username).enabled = true;
      return {};
    },
    AdminDisableUser(input) {
      user(pool(input.UserPoolId), input.Username).enabled = false;
      return {};
    },
    AdminUpdateUserAttributes(input) {
      applyAttributes(user(pool(input.UserPoolId), input.Username), input.UserAttributes);
      return {};
    },
    AdminDeleteUser(input) {
      const state = pool(input.UserPoolId);
      const entry = user(state, input.Username);
      state.users.delete(userKey(state, entry.username));
      return {};
    },
    async AdminInitiateAuth(input) {
      const state = pool(input.UserPoolId);
      const entry = client(state, input.ClientId);
      if (input.AuthFlow !== 'CUSTOM_AUTH') {
        throw new FakeError('InvalidParameterException', 'The fake supports only CUSTOM_AUTH.');
      }
      if (!entry.explicitAuthFlows.includes('ALLOW_CUSTOM_AUTH')) {
        throw new FakeError('InvalidParameterException', 'Auth flow not enabled for this client');
      }
      const lambda = state.lambdaConfig;
      if (
        !lambda.DefineAuthChallenge ||
        !lambda.CreateAuthChallenge ||
        !lambda.VerifyAuthChallengeResponse
      ) {
        throw new FakeError(
          'InvalidParameterException',
          'Custom auth lambda trigger is not configured for the user pool.',
        );
      }
      const username = str(input.AuthParameters?.USERNAME);
      const subject = findUser(state, username);
      if (!subject) {
        if (entry.preventUserExistenceErrors === 'ENABLED') {
          await runTrigger(
            triggerEvent(state, CognitoTriggerSource.define, username, {
              session: [],
              userNotFound: true,
            }),
          );
          throw new FakeError('NotAuthorizedException', 'Incorrect username or password.');
        }
        throw new FakeError('UserNotFoundException', 'User does not exist.');
      }
      if (!subject.enabled) throw new FakeError('NotAuthorizedException', 'User is disabled.');
      return challengeOrTokens(
        {
          poolId: state.id,
          clientId: entry.id,
          username: subject.username,
          session: [],
          privateParameters: {},
          expiresAt: 0,
        },
        state,
        entry,
        subject,
      );
    },
    async AdminRespondToAuthChallenge(input) {
      const state = pool(input.UserPoolId);
      const entry = client(state, input.ClientId);
      const auth = sessions.get(str(input.Session));
      sessions.delete(str(input.Session));
      if (
        !auth ||
        auth.expiresAt < Date.now() ||
        auth.poolId !== state.id ||
        auth.clientId !== entry.id
      ) {
        throw new FakeError(
          'NotAuthorizedException',
          'Invalid session for the user, session is expired.',
        );
      }
      const subject = user(state, auth.username);
      const responses = (input.ChallengeResponses ?? {}) as Record<string, string>;
      if (userKey(state, str(responses.USERNAME)) !== userKey(state, subject.username)) {
        throw new FakeError('NotAuthorizedException', 'Incorrect username or password.');
      }
      if (!subject.enabled) throw new FakeError('NotAuthorizedException', 'User is disabled.');
      if (input.ChallengeName !== 'CUSTOM_CHALLENGE') {
        throw new FakeError('InvalidParameterException', 'Unexpected challenge name.');
      }
      const verified = await runTrigger(
        triggerEvent(state, CognitoTriggerSource.verify, subject.username, {
          userAttributes: Object.fromEntries(subject.attributes),
          privateChallengeParameters: auth.privateParameters,
          challengeAnswer: str(responses.ANSWER),
        }),
      );
      const next: AuthSession = {
        ...auth,
        session: [
          ...auth.session,
          {
            challengeName: 'CUSTOM_CHALLENGE',
            challengeResult: verified.response.answerCorrect === true,
            ...(auth.challengeMetadata ? { challengeMetadata: auth.challengeMetadata } : {}),
          },
        ],
      };
      return challengeOrTokens(next, state, entry, subject);
    },
    RevokeToken(input) {
      const token = refreshTokens.get(str(input.Token));
      const owner = [...pools.values()].find((entry) => entry.clients.has(str(input.ClientId)));
      const entry = owner?.clients.get(str(input.ClientId));
      if (!entry) throw new FakeError('ResourceNotFoundException', 'Client does not exist.');
      if (entry.secret && entry.secret !== str(input.ClientSecret)) {
        throw new FakeError('NotAuthorizedException', 'Client secret is invalid.');
      }
      if (token && token.clientId === entry.id) token.revoked = true;
      return {};
    },
  };

  async function handleApi(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = str(request.headers['x-amz-target']);
    const action = target.split('.').pop() ?? '';
    const body = await readBody(request);
    const input = (body ? JSON.parse(body) : {}) as Record<string, unknown>;
    calls.push({ action, input });
    try {
      const failure = failures.get(action);
      if (failure) {
        throw new FakeError(failure, `Injected ${failure}`, SERVER_FAULTS.has(failure) ? 500 : 400);
      }
      const handler = actions[action];
      if (!handler)
        throw new FakeError('InvalidParameterException', `Unsupported action ${action}.`);
      sendJson(response, 200, (await handler(input)) ?? {});
    } catch (error) {
      if (error instanceof FakeError) return sendError(response, error);
      sendError(response, new FakeError('InternalErrorException', String(error), 500));
    }
  }

  function discovery(state: PoolState) {
    const issuer = issuerFor(state.id);
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth2/authorize`,
      token_endpoint: `${issuer}/oauth2/token`,
      userinfo_endpoint: `${issuer}/oauth2/userInfo`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ['code', 'token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'email', 'phone', 'profile'],
    };
  }

  function authorize(state: PoolState, params: URLSearchParams, response: ServerResponse): void {
    const query = Object.fromEntries(params.entries());
    state.lastAuthorize = query;
    const entry = state.clients.get(str(query.client_id));
    const redirectUri = str(query.redirect_uri);
    if (!entry || !entry.callbackUrls.includes(redirectUri)) {
      response.writeHead(400);
      response.end('invalid client or redirect_uri');
      return;
    }
    const fail = (error: string) => {
      const url = new URL(redirectUri);
      url.searchParams.set('error', error);
      if (query.state) url.searchParams.set('state', query.state);
      redirect(response, url.toString());
    };
    if (query.response_type !== 'code' || !entry.allowedOAuthFlows.includes('code')) {
      fail('unsupported_response_type');
      return;
    }
    const scopes = str(query.scope).split(' ').filter(Boolean);
    if (scopes.some((scope) => !entry.allowedOAuthScopes.includes(scope))) {
      fail('invalid_scope');
      return;
    }
    if (
      query.identity_provider &&
      !entry.supportedIdentityProviders.includes(query.identity_provider)
    ) {
      fail('invalid_request');
      return;
    }
    if (query.code_challenge && query.code_challenge_method !== 'S256') {
      fail('invalid_request');
      return;
    }
    const subject = state.hostedLoginUser ? findUser(state, state.hostedLoginUser) : undefined;
    if (!subject || !subject.enabled) {
      response.writeHead(403);
      response.end('no enabled hosted-login user configured for this pool');
      return;
    }
    // A user still on their temporary password chooses a new one at this first sign-in.
    if (subject.status === 'FORCE_CHANGE_PASSWORD') subject.status = 'CONFIRMED';
    const code = randomBytes(24).toString('base64url');
    codes.set(code, {
      poolId: state.id,
      clientId: entry.id,
      username: subject.username,
      redirectUri,
      ...(query.nonce ? { nonce: query.nonce } : {}),
      ...(query.code_challenge ? { codeChallenge: query.code_challenge } : {}),
      scope: scopes.join(' '),
      authTime: seconds(),
    });
    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (query.state) url.searchParams.set('state', query.state);
    redirect(response, url.toString());
  }

  async function token(
    state: PoolState,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const form = new URLSearchParams(await readBody(request));
    const invalid = (error: string, status = 400) =>
      sendJson(response, status, { error }, 'application/json');
    let clientId = form.get('client_id') ?? '';
    let secret = form.get('client_secret') ?? '';
    const basic = str(request.headers.authorization);
    if (basic.startsWith('Basic ')) {
      const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      clientId = decodeURIComponent(decoded.slice(0, separator));
      secret = decodeURIComponent(decoded.slice(separator + 1));
    }
    const entry = state.clients.get(clientId);
    if (!entry || (entry.secret && entry.secret !== secret)) return invalid('invalid_client', 401);
    if (form.get('grant_type') !== 'authorization_code') return invalid('unsupported_grant_type');
    const code = codes.get(form.get('code') ?? '');
    codes.delete(form.get('code') ?? '');
    if (!code || code.clientId !== entry.id || code.redirectUri !== form.get('redirect_uri')) {
      return invalid('invalid_grant');
    }
    if (code.codeChallenge) {
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== code.codeChallenge) return invalid('invalid_grant');
    }
    const subject = findUser(state, code.username);
    if (!subject || !subject.enabled) return invalid('invalid_grant');
    const tokens = await issueTokens(state, entry, subject, {
      ...(code.nonce ? { nonce: code.nonce } : {}),
      authTime: code.authTime,
      scope: code.scope,
    });
    sendJson(
      response,
      200,
      {
        id_token: tokens.idToken,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: 'Bearer',
        expires_in: 300,
      },
      'application/json',
    );
  }

  function userInfo(state: PoolState, request: IncomingMessage, response: ServerResponse): void {
    const header = str(request.headers.authorization);
    const access = accessTokens.get(header.startsWith('Bearer ') ? header.slice(7) : '');
    const subject = access?.poolId === state.id ? findUser(state, access.username) : undefined;
    if (!subject) {
      sendJson(response, 401, { error: 'invalid_token' }, 'application/json');
      return;
    }
    sendJson(
      response,
      200,
      { sub: subject.sub, username: subject.username, ...Object.fromEntries(subject.attributes) },
      'application/json',
    );
  }

  function logout(params: URLSearchParams, response: ServerResponse): void {
    const clientId = params.get('client_id') ?? '';
    const logoutUri = params.get('logout_uri') ?? '';
    const entry = [...pools.values()]
      .flatMap((state) => [...state.clients.values()])
      .find((c) => c.id === clientId);
    if (!entry || !entry.logoutUrls.includes(logoutUri)) {
      response.writeHead(400);
      response.end('invalid client_id or logout_uri');
      return;
    }
    redirect(response, logoutUri);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', endpoint);
    if (request.method === 'POST' && url.pathname === '/') return handleApi(request, response);
    if (request.method === 'GET' && url.pathname === '/logout')
      return logout(url.searchParams, response);
    const [, poolId = '', ...rest] = url.pathname.split('/');
    const state = pools.get(poolId);
    const path = `/${rest.join('/')}`;
    if (!state) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    if (request.method === 'GET' && path === '/.well-known/jwks.json') {
      return sendJson(response, 200, { keys: [state.jwk] }, 'application/json');
    }
    if (request.method === 'GET' && path === '/.well-known/openid-configuration') {
      return sendJson(response, 200, discovery(state), 'application/json');
    }
    if (request.method === 'GET' && path === '/oauth2/authorize') {
      return authorize(state, url.searchParams, response);
    }
    if (request.method === 'POST' && path === '/oauth2/token')
      return token(state, request, response);
    if (request.method === 'GET' && path === '/oauth2/userInfo')
      return userInfo(state, request, response);
    response.writeHead(404);
    response.end('not found');
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const reachable = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const printable = reachable.includes(':') ? `[${reachable}]` : reachable;
  endpoint = `http://${printable}:${(server.address() as AddressInfo).port}`;

  function poolOrThrow(userPoolId: string): PoolState {
    const found = pools.get(userPoolId);
    if (!found) throw new Error(`fake Cognito has no pool ${userPoolId}`);
    return found;
  }

  return {
    endpoint,
    region,
    credentials,
    clientConfig: { region, endpoint, credentials },
    calls,
    issuerFor,
    pools: () =>
      [...pools.values()].map((state) => ({
        id: state.id,
        name: state.name,
        tags: { ...state.tags },
        deletionProtection: state.deletionProtection,
        allowAdminCreateUserOnly: state.allowAdminCreateUserOnly,
        lambdaConfig: { ...state.lambdaConfig },
      })),
    users: (userPoolId) =>
      [...poolOrThrow(userPoolId).users.values()].map((entry) => ({
        username: entry.username,
        subject: entry.sub,
        enabled: entry.enabled,
        status: entry.status,
        attributes: Object.fromEntries(entry.attributes),
      })),
    deliveries: (userPoolId) =>
      deliveries
        .filter((entry) => entry.poolId === userPoolId)
        .map(({ username, email, kind }) => ({ username, email, kind })),
    refreshTokens: (userPoolId) =>
      [...refreshTokens.values()]
        .filter((entry) => entry.poolId === userPoolId)
        .map((entry) => ({ username: entry.username, revoked: entry.revoked })),
    setHostedLoginUser(userPoolId, username) {
      poolOrThrow(userPoolId).hostedLoginUser = username;
    },
    markFederated(userPoolId, username, providerName) {
      const state = poolOrThrow(userPoolId);
      const entry = findUser(state, username);
      if (!entry) throw new Error(`fake Cognito pool ${userPoolId} has no user ${username}`);
      entry.identities = [
        {
          userId: entry.sub,
          providerName,
          providerType: 'OIDC',
          issuer: null,
          primary: 'true',
          dateCreated: String(Date.now()),
        },
      ];
    },
    failAction(action, errorName = 'InternalErrorException') {
      failures.set(action, errorName);
    },
    clearFailures() {
      failures.clear();
    },
    lastAuthorizeParams: (userPoolId) => poolOrThrow(userPoolId).lastAuthorize,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
