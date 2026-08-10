import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import Fastify, { type FastifyReply } from 'fastify';

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

type CodeEntry = { sub: string; nonce: string };
type AccessTokenEntry = { sub: string };

function pickFakeSub(params: Record<string, unknown> | undefined, fallback: string): string {
  const fromParams = params?.fake_sub;
  if (typeof fromParams === 'string' && fromParams.length > 0) {
    return fromParams;
  }
  return fallback;
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
  const codes = new Map<string, CodeEntry>();
  const accessTokens = new Map<string, AccessTokenEntry>();
  const defaultSub = opts.subOverride ?? 'test-subject';
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

  async function completeAuthorize(
    params: Record<string, string>,
    reply: FastifyReply,
  ): Promise<void> {
    if (opts.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    }
    if (opts.errorOnAuthorize) {
      const redirectUri = String(params.redirect_uri ?? '');
      const url = new URL(redirectUri);
      url.searchParams.set('error', opts.errorOnAuthorize);
      url.searchParams.set('state', String(params.state ?? ''));
      await reply.redirect(url.toString());
      return;
    }
    lastAuthorizeParams = { ...params };
    const code = randomBytes(16).toString('hex');
    codes.set(code, {
      sub: pickFakeSub(params, defaultSub),
      nonce: opts.nonceOverride ?? params.nonce ?? '',
    });
    const redirect = new URL(params.redirect_uri ?? '');
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', params.state ?? '');
    await reply.redirect(redirect.toString());
  }

  app.get('/authorize', async (req, reply) => {
    const query = req.query as Record<string, string>;
    await completeAuthorize(query, reply);
  });

  app.post('/authorize', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, string>;
    const body = (req.body ?? {}) as Record<string, string>;
    await completeAuthorize({ ...query, ...body }, reply);
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
    const accessToken = randomBytes(16).toString('hex');
    accessTokens.set(accessToken, { sub: entry.sub });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      id_token: `${signingInput}.${signature}`,
    };
  });

  app.get('/userinfo', async (req) => {
    if (opts.userinfoSubOverride) {
      return {
        sub: opts.userinfoSubOverride,
        email: 'user@example.com',
      };
    }

    const authorization = req.headers.authorization;
    let sub = defaultSub;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      const token = authorization.slice('Bearer '.length).trim();
      const entry = accessTokens.get(token);
      if (entry) {
        sub = entry.sub;
      }
    }

    return {
      sub,
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
        sub: String(claims.sub ?? defaultSub),
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
