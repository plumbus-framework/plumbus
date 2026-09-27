import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAttestation } from '../attestation/index.js';
import {
  CognitoServerError,
  CognitoServerErrorReason,
  cognitoUserPoolIssuer,
  createCognitoIdTokenVerifier,
  createCognitoPoolAdministration,
  createCognitoPoolDirectory,
  createCognitoPoolUsers,
  regionOfUserPool,
  toCognitoServerError,
} from '../server/index.js';
import { type FakeCognito, startFakeCognito } from '../testing/index.js';

const KEYS = [{ id: 'k1', secret: 'k'.repeat(32) }];
const TRIGGER = 'arn:aws:lambda:eu-west-1:000000000000:function:attested-sign-in';
const TAGS = { 'plumbus:owner': 'test-suite', 'plumbus:tenant': 'tenant-a' };

async function rejection(promise: Promise<unknown>): Promise<CognitoServerError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CognitoServerError);
    return error as CognitoServerError;
  }
  throw new Error('expected a rejection');
}

describe('issuer derivation', () => {
  it('names the AWS IdP issuer, or the endpoint override', () => {
    expect(cognitoUserPoolIssuer('eu-west-1_AbC123')).toBe(
      'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_AbC123',
    );
    expect(cognitoUserPoolIssuer('eu-west-1_AbC123', { endpoint: 'http://127.0.0.1:9/' })).toBe(
      'http://127.0.0.1:9/eu-west-1_AbC123',
    );
    expect(regionOfUserPool('ap-southeast-2_x1')).toBe('ap-southeast-2');
    expect(() => cognitoUserPoolIssuer('not a pool')).toThrow(/user pool id/);
  });

  it('maps SDK failures to stable reasons', () => {
    const sdk = (name: string, message = 'm', status: number | undefined = 400) =>
      toCognitoServerError({ name, message, $metadata: { httpStatusCode: status } }).reason;
    expect(sdk('UserNotFoundException')).toBe('user-not-found');
    expect(sdk('NotAuthorizedException', 'User is disabled.')).toBe('user-disabled');
    expect(sdk('NotAuthorizedException', 'Incorrect username or password.')).toBe(
      'challenge-refused',
    );
    expect(sdk('ResourceNotFoundException')).toBe('pool-not-found');
    expect(sdk('UserLambdaValidationException')).toBe('trigger-failed');
    expect(sdk('TooManyRequestsException')).toBe('provider-unavailable');
    expect(sdk('InternalErrorException', 'm', 500)).toBe('provider-unavailable');
    expect(sdk('InvalidParameterException')).toBe('request-refused');
    expect(toCognitoServerError(new TypeError('fetch failed')).reason).toBe('provider-unavailable');
  });
});

describe('fake Cognito listening address', () => {
  it('listens on a fixed port and host, and refuses a taken port', async () => {
    const probe = await startFakeCognito();
    const port = Number(new URL(probe.endpoint).port);
    await probe.close();

    const fixed = await startFakeCognito({ port, host: '0.0.0.0' });
    try {
      expect(fixed.endpoint).toBe(`http://127.0.0.1:${port}`);
      const admin = createCognitoPoolAdministration({ ...fixed.clientConfig, maxAttempts: 1 });
      const pool = await admin.ensureAttestedUserPool({
        name: 'fixed-port',
        tags: TAGS,
        triggerArn: TRIGGER,
      });
      expect(pool.issuer).toBe(`http://127.0.0.1:${port}/${pool.userPoolId}`);
      await expect(startFakeCognito({ port, host: '0.0.0.0' })).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await fixed.close();
    }
  });
});

describe('server against the fake Cognito', () => {
  let fake: FakeCognito;
  let admin: ReturnType<typeof createCognitoPoolAdministration>;

  beforeAll(async () => {
    fake = await startFakeCognito({ attestationKeys: KEYS });
    admin = createCognitoPoolAdministration({ ...fake.clientConfig, maxAttempts: 1 });
  });

  afterAll(async () => {
    await fake.close();
  });

  beforeEach(() => fake.clearFailures());

  async function freshPool(name: string) {
    const pool = await admin.ensureAttestedUserPool({ name, tags: TAGS, triggerArn: TRIGGER });
    const users = createCognitoPoolUsers({
      ...fake.clientConfig,
      maxAttempts: 1,
      userPoolId: pool.userPoolId,
      clientId: pool.clientId,
      attestationKeys: KEYS,
    });
    return { pool, users };
  }

  it('creates an attested pool once, then finds it again', async () => {
    const first = await admin.ensureAttestedUserPool({
      name: 'tenant-a-users',
      tags: TAGS,
      triggerArn: TRIGGER,
    });
    expect(first.created).toBe(true);
    expect(first.issuer).toBe(`${fake.endpoint}/${first.userPoolId}`);
    const again = await admin.ensureAttestedUserPool({
      name: 'tenant-a-users',
      tags: TAGS,
      triggerArn: TRIGGER,
    });
    expect(again).toEqual({ ...first, created: false });

    const pool = fake.pools().find((entry) => entry.id === first.userPoolId);
    expect(pool).toMatchObject({
      allowAdminCreateUserOnly: true,
      deletionProtection: 'ACTIVE',
      lambdaConfig: {
        DefineAuthChallenge: TRIGGER,
        CreateAuthChallenge: TRIGGER,
        VerifyAuthChallengeResponse: TRIGGER,
      },
    });
    const clientCall = fake.calls.find((call) => call.action === 'CreateUserPoolClient');
    expect(clientCall?.input).toMatchObject({
      GenerateSecret: false,
      ExplicitAuthFlows: ['ALLOW_CUSTOM_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      EnableTokenRevocation: true,
      PreventUserExistenceErrors: 'ENABLED',
    });
  });

  it('reconciles a pool whose trigger drifted, and refuses a same-named foreign pool', async () => {
    await admin.ensureAttestedUserPool({ name: 'drifting', tags: TAGS, triggerArn: TRIGGER });
    const moved = `${TRIGGER}-v2`;
    await admin.ensureAttestedUserPool({ name: 'drifting', tags: TAGS, triggerArn: moved });
    const pool = fake.pools().find((entry) => entry.name === 'drifting');
    expect(pool?.lambdaConfig.VerifyAuthChallengeResponse).toBe(moved);
    expect(pool?.allowAdminCreateUserOnly).toBe(true);

    const conflict = await rejection(
      admin.ensureAttestedUserPool({
        name: 'drifting',
        tags: { 'plumbus:owner': 'someone-else' },
        triggerArn: TRIGGER,
      }),
    );
    expect(conflict.reason).toBe(CognitoServerErrorReason.poolConflict);
    await expect(
      admin.ensureAttestedUserPool({ name: 'x', tags: {}, triggerArn: TRIGGER }),
    ).rejects.toThrow(/ownership tag/);
  });

  it('ensures a confirmed user with a verified email and no Cognito message', async () => {
    const { pool, users } = await freshPool('users-ensure');
    const created = await users.ensureUser({ username: 'account-1', email: 'a@tenant-a.example' });
    expect(created).toMatchObject({ username: 'account-1', status: 'CONFIRMED', created: true });
    expect(created.subject).toMatch(/[0-9a-f-]{36}/);
    const again = await users.ensureUser({ username: 'account-1', email: 'a@tenant-a.example' });
    expect(again).toMatchObject({ subject: created.subject, created: false });

    const createCall = fake.calls.find((call) => call.action === 'AdminCreateUser');
    expect(createCall?.input.MessageAction).toBe('SUPPRESS');
    expect(fake.users(pool.userPoolId)[0]?.attributes).toMatchObject({
      email: 'a@tenant-a.example',
      email_verified: 'true',
    });
    expect(await users.getUser('nobody')).toBeNull();
  });

  it('confirms a user whose creation stopped before the password was set', async () => {
    const { users } = await freshPool('users-half-created');
    fake.failAction('AdminSetUserPassword', 'InternalErrorException');
    await rejection(users.ensureUser({ username: 'account-2' }));
    fake.clearFailures();
    const recovered = await users.ensureUser({ username: 'account-2' });
    expect(recovered).toMatchObject({ status: 'CONFIRMED', created: false });
  });

  it('signs a user in with an attestation and revokes the refresh token', async () => {
    const { pool, users } = await freshPool('users-sign-in');
    const user = await users.ensureUser({ username: 'account-3', email: 'c@tenant-a.example' });
    const identity = await users.signIn({
      username: 'account-3',
      clientMetadata: { tenant: 'tenant-a' },
    });
    expect(identity).toMatchObject({
      issuer: pool.issuer,
      subject: user.subject,
      username: 'account-3',
      email: 'c@tenant-a.example',
      emailVerified: true,
    });
    expect(identity.authTime.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(identity.claims.token_use).toBe('id');
    expect(fake.refreshTokens(pool.userPoolId)).toEqual([{ username: 'account-3', revoked: true }]);
    const respond = fake.calls.filter((call) => call.action === 'AdminRespondToAuthChallenge');
    expect(respond.at(-1)?.input.ClientMetadata).toEqual({ tenant: 'tenant-a' });
  });

  it('refuses disabled users, unknown users and a server without the keyring', async () => {
    const { pool, users } = await freshPool('users-refusals');
    await users.ensureUser({ username: 'account-4' });

    await users.setUserEnabled('account-4', false);
    expect((await rejection(users.signIn({ username: 'account-4' }))).reason).toBe('user-disabled');
    await users.setUserEnabled('account-4', true);
    expect(await users.setUserEnabled('missing', false)).toEqual({ found: false });

    expect((await rejection(users.signIn({ username: 'missing' }))).reason).toBe(
      'challenge-refused',
    );

    const impostor = createCognitoPoolUsers({
      ...fake.clientConfig,
      maxAttempts: 1,
      userPoolId: pool.userPoolId,
      clientId: pool.clientId,
      attestationKeys: [{ id: 'k1', secret: 'x'.repeat(32) }],
    });
    expect((await rejection(impostor.signIn({ username: 'account-4' }))).reason).toBe(
      'challenge-refused',
    );
  });

  it('never accepts another pool’s tokens, and reports outages as unavailable', async () => {
    const a = await freshPool('pool-a');
    const b = await freshPool('pool-b');
    await a.users.ensureUser({ username: 'shared-name' });
    await b.users.ensureUser({ username: 'shared-name' });

    // Drive pool A's exchange by hand to hold its raw ID token.
    const sdk = await import('@aws-sdk/client-cognito-identity-provider');
    const client = new sdk.CognitoIdentityProviderClient(fake.clientConfig);
    const initiated = await client.send(
      new sdk.AdminInitiateAuthCommand({
        UserPoolId: a.pool.userPoolId,
        ClientId: a.pool.clientId,
        AuthFlow: 'CUSTOM_AUTH',
        AuthParameters: { USERNAME: 'shared-name' },
      }),
    );
    const answer = signAttestation(KEYS, {
      userPoolId: a.pool.userPoolId,
      username: 'shared-name',
      nonce: initiated.ChallengeParameters?.nonce ?? '',
    });
    const responded = await client.send(
      new sdk.AdminRespondToAuthChallengeCommand({
        UserPoolId: a.pool.userPoolId,
        ClientId: a.pool.clientId,
        ChallengeName: 'CUSTOM_CHALLENGE',
        ChallengeResponses: { USERNAME: 'shared-name', ANSWER: answer },
        Session: initiated.Session,
      }),
    );
    const idTokenA = responded.AuthenticationResult?.IdToken ?? '';
    const verifierA = createCognitoIdTokenVerifier({
      issuer: a.pool.issuer,
      clientId: a.pool.clientId,
    });
    const verifierB = createCognitoIdTokenVerifier({
      issuer: b.pool.issuer,
      clientId: b.pool.clientId,
    });
    await expect(verifierA.verify(idTokenA)).resolves.toMatchObject({ token_use: 'id' });
    await expect(verifierB.verify(idTokenA)).rejects.toMatchObject({ reason: 'token-invalid' });
    await expect(verifierB.verify('not-a-jwt')).rejects.toMatchObject({ reason: 'token-invalid' });

    // Pool A's attestation for the same username is useless at pool B.
    const initiatedB = await client.send(
      new sdk.AdminInitiateAuthCommand({
        UserPoolId: b.pool.userPoolId,
        ClientId: b.pool.clientId,
        AuthFlow: 'CUSTOM_AUTH',
        AuthParameters: { USERNAME: 'shared-name' },
      }),
    );
    const replayed = signAttestation(KEYS, {
      userPoolId: a.pool.userPoolId,
      username: 'shared-name',
      nonce: initiatedB.ChallengeParameters?.nonce ?? '',
    });
    await expect(
      client.send(
        new sdk.AdminRespondToAuthChallengeCommand({
          UserPoolId: b.pool.userPoolId,
          ClientId: b.pool.clientId,
          ChallengeName: 'CUSTOM_CHALLENGE',
          ChallengeResponses: { USERNAME: 'shared-name', ANSWER: replayed },
          Session: initiatedB.Session,
        }),
      ),
    ).rejects.toMatchObject({ name: 'NotAuthorizedException' });

    fake.failAction('AdminInitiateAuth', 'InternalErrorException');
    expect((await rejection(a.users.signIn({ username: 'shared-name' }))).reason).toBe(
      'provider-unavailable',
    );
    fake.failAction('AdminInitiateAuth', 'TooManyRequestsException');
    expect((await rejection(a.users.signIn({ username: 'shared-name' }))).reason).toBe(
      'provider-unavailable',
    );
  });

  it('updates the email attribute and keeps it verified', async () => {
    const { pool, users } = await freshPool('users-email');
    await users.ensureUser({ username: 'account-5', email: 'old@tenant-a.example' });
    await users.updateEmail('account-5', 'new@tenant-a.example');
    expect(fake.users(pool.userPoolId)[0]?.attributes).toMatchObject({
      email: 'new@tenant-a.example',
      email_verified: 'true',
    });
    const identity = await users.signIn({ username: 'account-5' });
    expect(identity.email).toBe('new@tenant-a.example');
  });

  it('deletes only an owned pool, idempotently, without weakening it on the way', async () => {
    const { pool } = await freshPool('to-delete');
    expect(
      (
        await rejection(
          admin.deleteUserPool({ userPoolId: pool.userPoolId, tags: { other: 'owner' } }),
        )
      ).reason,
    ).toBe('pool-conflict');

    fake.failAction('DeleteUserPool', 'InternalErrorException');
    await rejection(admin.deleteUserPool({ userPoolId: pool.userPoolId, tags: TAGS }));
    const halfway = fake.pools().find((entry) => entry.id === pool.userPoolId);
    expect(halfway).toMatchObject({
      deletionProtection: 'INACTIVE',
      allowAdminCreateUserOnly: true,
    });
    expect(halfway?.lambdaConfig.VerifyAuthChallengeResponse).toBe(TRIGGER);

    fake.clearFailures();
    expect(await admin.deleteUserPool({ userPoolId: pool.userPoolId, tags: TAGS })).toEqual({
      deleted: true,
    });
    expect(await admin.deleteUserPool({ userPoolId: pool.userPoolId, tags: TAGS })).toEqual({
      deleted: false,
    });
  });

  it('reads a pool’s MFA policy', async () => {
    const { pool } = await freshPool('mfa-read');
    expect(await admin.readMfaPolicy(pool.userPoolId)).toEqual({
      mfa: 'OFF',
      softwareToken: false,
      sms: false,
      email: false,
    });
    const { CognitoIdentityProviderClient, SetUserPoolMfaConfigCommand } = await import(
      '@aws-sdk/client-cognito-identity-provider'
    );
    const sdk = new CognitoIdentityProviderClient(fake.clientConfig);
    await sdk.send(
      new SetUserPoolMfaConfigCommand({
        UserPoolId: pool.userPoolId,
        MfaConfiguration: 'ON',
        SoftwareTokenMfaConfiguration: { Enabled: true },
      }),
    );
    expect(await admin.readMfaPolicy(pool.userPoolId)).toEqual({
      mfa: 'ON',
      softwareToken: true,
      sms: false,
      email: false,
    });
    expect((await rejection(admin.readMfaPolicy('eu-west-1_Missing1'))).reason).toBe(
      'pool-not-found',
    );
  });
});

describe('a pool directory, for administering a hosted-login pool', () => {
  let fake: FakeCognito;
  let poolId = '';
  let directory: ReturnType<typeof createCognitoPoolDirectory>;

  beforeAll(async () => {
    fake = await startFakeCognito();
    const sdk = await import('@aws-sdk/client-cognito-identity-provider');
    const client = new sdk.CognitoIdentityProviderClient(fake.clientConfig);
    const pool = await client.send(new sdk.CreateUserPoolCommand({ PoolName: 'operators' }));
    poolId = pool.UserPool?.Id ?? '';
    directory = createCognitoPoolDirectory({
      ...fake.clientConfig,
      maxAttempts: 1,
      userPoolId: poolId,
    });
  });

  afterAll(async () => {
    await fake.close();
  });

  it('invites once: Cognito mails a temporary password and the user waits for first sign-in', async () => {
    const invited = await directory.inviteUser({ email: 'omer@ops.example', name: 'Omer Shahar' });
    expect(invited).toMatchObject({
      username: 'omer@ops.example',
      status: 'FORCE_CHANGE_PASSWORD',
      created: true,
    });
    expect(invited.subject).toMatch(/[0-9a-f-]{36}/);
    expect(fake.users(poolId)[0]?.attributes).toMatchObject({
      email: 'omer@ops.example',
      email_verified: 'true',
      name: 'Omer Shahar',
    });
    const again = await directory.inviteUser({ email: 'omer@ops.example' });
    expect(again).toMatchObject({ subject: invited.subject, created: false });
    expect(fake.deliveries(poolId)).toEqual([
      { username: 'omer@ops.example', email: 'omer@ops.example', kind: 'invitation' },
    ]);
  });

  it('resends the invitation to a user who has not signed in, and only to them', async () => {
    await directory.resendInvitation('omer@ops.example');
    expect(fake.deliveries(poolId).at(-1)).toMatchObject({ kind: 'resend' });
    const sdk = await import('@aws-sdk/client-cognito-identity-provider');
    const client = new sdk.CognitoIdentityProviderClient(fake.clientConfig);
    await client.send(
      new sdk.AdminSetUserPasswordCommand({
        UserPoolId: poolId,
        Username: 'omer@ops.example',
        Password: 'Chosen-password-1',
        Permanent: true,
      }),
    );
    expect((await rejection(directory.resendInvitation('omer@ops.example'))).reason).toBe(
      'request-refused',
    );
  });

  it('disables, enables and looks up users, and knows an unknown one', async () => {
    expect(await directory.setUserEnabled('omer@ops.example', false)).toEqual({ found: true });
    expect(await directory.getUser('omer@ops.example')).toMatchObject({
      enabled: false,
      status: 'CONFIRMED',
    });
    expect(await directory.setUserEnabled('omer@ops.example', true)).toEqual({ found: true });
    expect(await directory.getUser('nobody@ops.example')).toBeNull();
    expect(await directory.setUserEnabled('nobody@ops.example', false)).toEqual({ found: false });
    await expect(directory.inviteUser({ email: 'not-an-address' })).rejects.toThrow(/email/);
  });

  it('lists every user with their address and name, across pages', async () => {
    for (let index = 0; index < 61; index += 1) {
      await directory.inviteUser({ email: `bulk-${index}@ops.example`, sendInvitation: false });
    }
    const users = await directory.listUsers();
    expect(users).toHaveLength(62);
    expect(users.find((user) => user.email === 'omer@ops.example')).toMatchObject({
      name: 'Omer Shahar',
      status: 'CONFIRMED',
    });
  });

  it('deletes a user, and knows one that is already gone', async () => {
    expect(await directory.deleteUser('bulk-0@ops.example')).toEqual({ found: true });
    expect(await directory.getUser('bulk-0@ops.example')).toBeNull();
    expect(await directory.deleteUser('bulk-0@ops.example')).toEqual({ found: false });
  });
});

describe('a pool directory over an email-as-username pool', () => {
  let fake: FakeCognito;
  let poolId = '';
  let directory: ReturnType<typeof createCognitoPoolDirectory>;

  beforeAll(async () => {
    fake = await startFakeCognito();
    const sdk = await import('@aws-sdk/client-cognito-identity-provider');
    const client = new sdk.CognitoIdentityProviderClient(fake.clientConfig);
    const pool = await client.send(
      new sdk.CreateUserPoolCommand({ PoolName: 'operators', UsernameAttributes: ['email'] }),
    );
    poolId = pool.UserPool?.Id ?? '';
    directory = createCognitoPoolDirectory({
      ...fake.clientConfig,
      maxAttempts: 1,
      userPoolId: poolId,
    });
  });

  afterAll(async () => {
    await fake.close();
  });

  it('gives an invited address an opaque username, and answers to the address too', async () => {
    const invited = await directory.inviteUser({
      email: 'dana@ops.example',
      sendInvitation: false,
    });
    expect(invited.username).toBe(invited.subject);
    expect(invited.email).toBe('dana@ops.example');
    expect(await directory.getUser('dana@ops.example')).toMatchObject({
      username: invited.username,
    });
    expect(await directory.inviteUser({ email: 'dana@ops.example' })).toMatchObject({
      username: invited.username,
      created: false,
    });
  });

  it('mails nothing for a quiet invitation until the invitation is sent', async () => {
    const username = (await directory.listUsers())[0]?.username ?? '';
    expect(fake.deliveries(poolId)).toEqual([]);
    await directory.resendInvitation(username);
    expect(fake.deliveries(poolId)).toEqual([
      { username, email: 'dana@ops.example', kind: 'resend' },
    ]);
  });
});
