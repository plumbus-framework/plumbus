import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  createAuthRuntime,
  createMemoryLoginTransactionStore,
  createMemorySessionStore,
  type VerifiedExternalIdentity,
} from '@plumbus/auth';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cognito } from '../cognito.js';
import { type FakeCognito, startFakeCognito } from '../testing/index.js';

const STORAGE_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const EXTERNAL = 'http://127.0.0.1:3000';
const APPLICATION = 'http://127.0.0.1:5173';

/** A full `@plumbus/auth` code flow against a fake pool's hosted login, with `cognito()` pinned. */
describe('hosted login against the fake Cognito', () => {
  let fake: FakeCognito;
  let app: FastifyInstance;
  let poolId = '';
  let subject = '';
  const seen: VerifiedExternalIdentity[] = [];

  beforeAll(async () => {
    fake = await startFakeCognito();
    const sdk = new CognitoIdentityProviderClient(fake.clientConfig);
    const pool = await sdk.send(new CreateUserPoolCommand({ PoolName: 'operators' }));
    poolId = pool.UserPool?.Id ?? '';
    const client = await sdk.send(
      new CreateUserPoolClientCommand({
        UserPoolId: poolId,
        ClientName: 'operators-web',
        GenerateSecret: true,
        AllowedOAuthFlows: ['code'],
        AllowedOAuthFlowsUserPoolClient: true,
        AllowedOAuthScopes: ['openid', 'profile'],
        CallbackURLs: [`${EXTERNAL}/auth/callback/cognito`],
        LogoutURLs: [`${APPLICATION}/signed-out`],
        SupportedIdentityProviders: ['COGNITO'],
      }),
    );
    const created = await sdk.send(
      new AdminCreateUserCommand({
        UserPoolId: poolId,
        Username: 'operator-1',
        MessageAction: 'SUPPRESS',
      }),
    );
    subject = created.User?.Attributes?.find((entry) => entry.Name === 'sub')?.Value ?? '';
    await sdk.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: poolId,
        Username: 'operator-1',
        Password: 'Correct-horse-1',
        Permanent: true,
      }),
    );
    fake.setHostedLoginUser(poolId, 'operator-1');

    const runtime = createAuthRuntime({
      applicationId: 'operators',
      externalBaseUrl: EXTERNAL,
      applicationBaseUrl: APPLICATION,
      defaultReturnPath: '/',
      errorPath: '/login/error',
      environment: 'development',
      session: { ttl: '1h' },
      providers: {
        cognito: {
          type: 'oidc',
          issuer: fake.issuerFor(poolId),
          clientId: client.UserPoolClient?.ClientId ?? '',
          clientSecret: client.UserPoolClient?.ClientSecret ?? '',
          scopes: ['openid', 'profile'],
          integration: cognito({
            hostedLogin: {
              allowedIdentityProviders: ['COGNITO'],
              defaultIdentityProvider: 'COGNITO',
            },
          }),
        },
      },
      defaultProvider: 'cognito',
      sessionStore: createMemorySessionStore(),
      transactionStore: createMemoryLoginTransactionStore(),
      storageProtection: { activeKey: { id: 'k1', value: STORAGE_KEY } },
      resolveIdentity: async (identity) => {
        seen.push(identity);
        return { status: 'admitted', userId: identity.subject };
      },
      resolveAuthorization: async () => ({ status: 'authorized', roles: ['admin'], scopes: [] }),
      deployment: { assumeSameSite: true },
    });
    await runtime.initialize();
    app = Fastify();
    runtime.registerRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await fake.close();
  });

  async function signIn(): Promise<number> {
    const login = await app.inject({ method: 'GET', url: '/auth/login/cognito?returnTo=/' });
    expect(login.statusCode).toBe(302);
    const authorize = await fetch(login.headers.location ?? '', { redirect: 'manual' });
    expect(authorize.status).toBe(302);
    const callback = new URL(authorize.headers.get('location') ?? '');
    const finished = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { cookie: login.headers['set-cookie'] ?? '' },
    });
    return finished.statusCode;
  }

  it('pins the COGNITO identity provider and completes PKCE + client-secret login', async () => {
    expect(await signIn()).toBe(303);
    const authorize = fake.lastAuthorizeParams(poolId);
    expect(authorize).toMatchObject({
      identity_provider: 'COGNITO',
      code_challenge_method: 'S256',
    });
    const identity = seen.at(-1);
    expect(identity?.issuer).toBe(fake.issuerFor(poolId));
    expect(identity?.subject).toBe(subject);
    expect(identity?.idTokenClaims['cognito:username']).toBe('operator-1');
    expect(identity?.idTokenClaims.identities).toBeUndefined();
    expect(identity?.amr).toBeUndefined();
  });

  it('confirms a user still on their temporary password at their first sign-in', async () => {
    const sdk = new CognitoIdentityProviderClient(fake.clientConfig);
    await sdk.send(
      new AdminCreateUserCommand({
        UserPoolId: poolId,
        Username: 'operator-2',
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );
    expect(fake.users(poolId).find((user) => user.username === 'operator-2')?.status).toBe(
      'FORCE_CHANGE_PASSWORD',
    );
    fake.setHostedLoginUser(poolId, 'operator-2');
    expect(await signIn()).toBe(303);
    expect(fake.users(poolId).find((user) => user.username === 'operator-2')?.status).toBe(
      'CONFIRMED',
    );
    fake.setHostedLoginUser(poolId, 'operator-1');
  });

  it('marks federated users with an identities claim', async () => {
    fake.markFederated(poolId, 'operator-1', 'Google');
    expect(await signIn()).toBe(303);
    const identities = seen.at(-1)?.idTokenClaims.identities as { providerName: string }[];
    expect(identities[0]?.providerName).toBe('Google');
  });
});
