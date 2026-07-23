import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import Fastify from 'fastify';

export interface FakeOidcProviderOptions {
  wrongIssuer?: boolean;
  badSignature?: boolean;
  nonceOverride?: string;
  expiredToken?: boolean;
  subOverride?: string;
  userinfoSubOverride?: string;
  errorOnAuthorize?: string;
  offline?: boolean;
  delayMs?: number;
  redirectChain?: number;
}

export interface FakeOidcProvider {
  issuer: string;
  port: number;
  close(): Promise<void>;
  lastAuthorizeParams: Record<string, string> | null;
  issueCodeFor(claims: Record<string, unknown>): string;
}

export async function startFakeOidcProvider(
  opts: FakeOidcProviderOptions = {},
): Promise<FakeOidcProvider> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  jwk.kid = 'test-key';
  jwk.use = 'sig';
  jwk.alg = 'RS256';

  let lastAuthorizeParams: Record<string, string> | null = null;
  const codes = new Map<string, { sub: string; nonce: string }>();
  const issuerPath = opts.wrongIssuer ? '/wrong' : '';
  const app = Fastify({ logger: false });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      const params = new URLSearchParams(String(body));
      const record: Record<string, string> = {};
      for (const [key, value] of params.entries()) record[key] = value;
      done(null, record);
    },
  );

  app.get('/.well-known/openid-configuration', async (_req, reply) => {
    if (opts.offline) {
      reply.code(503);
      return { error: 'offline' };
    }
    const host = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    return {
      issuer: `${host}${issuerPath}`,
      authorization_endpoint: `${host}/authorize`,
      token_endpoint: `${host}/token`,
      jwks_uri: `${host}/jwks`,
      userinfo_endpoint: `${host}/userinfo`,
      end_session_endpoint: `${host}/logout`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    };
  });

  app.get('/jwks', async () => ({ keys: [jwk] }));

  app.get('/authorize', async (req, reply) => {
    if (opts.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    }
    if (opts.errorOnAuthorize) {
      const redirectUri = String((req.query as { redirect_uri?: string }).redirect_uri ?? '');
      const url = new URL(redirectUri);
      url.searchParams.set('error', opts.errorOnAuthorize);
      url.searchParams.set('state', String((req.query as { state?: string }).state ?? ''));
      return reply.redirect(url.toString());
    }
    const query = req.query as Record<string, string>;
    lastAuthorizeParams = { ...query };
    const code = randomBytes(16).toString('hex');
    codes.set(code, {
      sub: opts.subOverride ?? 'test-subject',
      nonce: opts.nonceOverride ?? query.nonce ?? '',
    });
    const redirect = new URL(query.redirect_uri ?? '');
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', query.state ?? '');
    return reply.redirect(redirect.toString());
  });

  app.post('/token', async (req, reply) => {
    const body = req.body as Record<string, string>;
    const code = body.code;
    if (!code) {
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    const entry = codes.get(code);
    if (!entry) {
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    codes.delete(code);
    const host = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const now = opts.expiredToken
      ? Math.floor(Date.now() / 1000) - 3600
      : Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: `${host}${issuerPath}`,
        sub: entry.sub,
        aud: body.client_id ?? 'test-client',
        exp: now + 3600,
        iat: now,
        nonce: entry.nonce,
      }),
    ).toString('base64url');
    const signingInput = `${header}.${payload}`;
    let signingKey = privateKey;
    if (opts.badSignature) {
      signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    }
    const signature = sign('RSA-SHA256', Buffer.from(signingInput), signingKey).toString(
      'base64url',
    );
    return {
      access_token: randomBytes(16).toString('hex'),
      token_type: 'Bearer',
      id_token: `${signingInput}.${signature}`,
    };
  });

  app.get('/userinfo', async () => {
    return {
      sub: opts.userinfoSubOverride ?? opts.subOverride ?? 'test-subject',
      email: 'user@example.com',
    };
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const issuer = `http://127.0.0.1:${port}${issuerPath}`;

  return {
    issuer,
    port,
    get lastAuthorizeParams() {
      return lastAuthorizeParams;
    },
    issueCodeFor(claims) {
      const code = randomBytes(16).toString('hex');
      codes.set(code, {
        sub: String(claims.sub ?? 'test-subject'),
        nonce: String(claims.nonce ?? ''),
      });
      return code;
    },
    close: () => app.close(),
  };
}

export function pkceChallengeFromVerifier(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
