// Server-attested sign-in demo: the app's own magic link, with Cognito behind it.
//
// This is the flow @plumbus/auth-cognito/server exists for. The app authenticates the
// person itself (here: a single-use sign-in link it "mails"), then signs that person into
// their Cognito user through custom auth, answering the pool trigger's nonce with an HMAC
// attestation, verifying the ID token against the pool's JWKS and revoking the refresh token.
//
// cognitox has no custom auth and no Lambda triggers (AdminInitiateAuth with CUSTOM_AUTH
// answers NotImplementedException), so this part runs against the package's own in-process
// fake Cognito (`@plumbus/auth-cognito/testing`). The fake speaks the Cognito JSON API to the
// real AWS SDK and runs the real `createAttestedSignInTrigger` in-process, so everything from
// the SDK call to the JWKS check is the production code path.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  CognitoServerError,
  createCognitoPoolAdministration,
  createCognitoPoolUsers,
  startFakeCognito,
} from './deps.mjs';

const LINK_TTL_MS = 5 * 60_000;
const POOL_TAGS = { 'smoke:owner': 'auth-cognito-smoke' };
const TRIGGER_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:smoke-attested-sign-in';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A refusal with a stable reason, shown to the person as-is. */
export class AttestedRefusal extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

const digest = (token) => createHash('sha256').update(token).digest('hex');

/**
 * Starts the fake pool and returns the demo's operations. `now` is injectable so the
 * automated check can expire a link without waiting five minutes.
 */
export async function startAttestedDemo({ log = () => {}, now = () => Date.now() } = {}) {
  // A fresh random keyring per run; the fake's trigger and the server share it, exactly as
  // a deployment's Lambda and application server share COGNITO_ATTESTATION_KEYS.
  const attestationKeys = [{ id: 'smoke-k1', secret: randomBytes(32).toString('base64url') }];
  const fake = await startFakeCognito({ region: 'us-east-1', attestationKeys });
  const connection = { ...fake.clientConfig, maxAttempts: 1 };
  const admin = createCognitoPoolAdministration(connection);
  const pool = await admin.ensureAttestedUserPool({
    name: 'auth-cognito-smoke-attested',
    tags: POOL_TAGS,
    triggerArn: TRIGGER_ARN,
  });
  log(`fake Cognito ${fake.endpoint} · attested pool ${pool.userPoolId} · client ${pool.clientId}`);
  const users = createCognitoPoolUsers({
    ...connection,
    userPoolId: pool.userPoolId,
    clientId: pool.clientId,
    attestationKeys,
    onWarning: (message, detail) => log(`warning: ${message} ${JSON.stringify(detail)}`),
  });

  // The app's own records. The Cognito username is the app's account id; Cognito is never
  // searched by email to decide who someone is.
  const accountsByEmail = new Map();
  const links = new Map();
  const sessions = new Map();
  let outage = false;

  function accountFor(email) {
    let accountId = accountsByEmail.get(email);
    if (!accountId) {
      accountId = `acct-${randomUUID()}`;
      accountsByEmail.set(email, accountId);
    }
    return accountId;
  }

  /** Step 1 — the app mints a single-use link. A real app mails it; the demo shows it. */
  function requestLink(rawEmail) {
    const email = String(rawEmail ?? '').trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw new AttestedRefusal('invalid-email', 'Enter an email address.');
    const token = randomBytes(24).toString('base64url');
    links.set(digest(token), { email, expiresAt: now() + LINK_TTL_MS });
    return { token, link: `/attested/redeem?token=${token}`, expiresInSeconds: LINK_TTL_MS / 1000 };
  }

  /** Step 2 — redeem the link (app auth), then sign the account into its Cognito user. */
  async function redeem(token) {
    const key = digest(String(token ?? ''));
    const entry = links.get(key);
    if (!entry) throw new AttestedRefusal('link-invalid', 'This sign-in link is unknown or was already used.');
    links.delete(key); // single use: consumed before anything else can fail
    if (entry.expiresAt <= now()) throw new AttestedRefusal('link-expired', 'This sign-in link expired.');
    const accountId = accountFor(entry.email);
    try {
      const user = await users.ensureUser({ username: accountId, email: entry.email });
      const identity = await users.signIn({
        username: accountId,
        clientMetadata: { app: 'auth-cognito-smoke' },
      });
      if (identity.subject !== user.subject) {
        throw new AttestedRefusal('subject-mismatch', 'Cognito signed in a different user.');
      }
      const sessionId = randomBytes(24).toString('base64url');
      sessions.set(sessionId, { accountId, email: entry.email, identity });
      return { sessionId, accountId, identity };
    } catch (error) {
      if (error instanceof CognitoServerError) throw new AttestedRefusal(error.reason, error.message);
      throw error;
    }
  }

  function session(sessionId) {
    const found = sessionId ? sessions.get(sessionId) : undefined;
    if (!found) return { authenticated: false };
    const poolUser = fake.users(pool.userPoolId).find((user) => user.username === found.accountId);
    const tokens = fake.refreshTokens(pool.userPoolId).filter((t) => t.username === found.accountId);
    return {
      authenticated: true,
      accountId: found.accountId,
      email: found.email,
      identity: {
        issuer: found.identity.issuer,
        subject: found.identity.subject,
        username: found.identity.username,
        email: found.identity.email,
        emailVerified: found.identity.emailVerified,
        authTime: found.identity.authTime.toISOString(),
        tokenUse: found.identity.claims.token_use,
      },
      cognitoUser: poolUser
        ? { status: poolUser.status, enabled: poolUser.enabled, attributes: poolUser.attributes }
        : null,
      refreshTokensIssued: tokens.length,
      refreshTokensRevoked: tokens.filter((t) => t.revoked).length,
    };
  }

  function logout(sessionId) {
    sessions.delete(sessionId);
  }

  /** Operator toggles for the negative paths. */
  async function setEnabled(rawEmail, enabled) {
    const accountId = accountsByEmail.get(String(rawEmail ?? '').trim().toLowerCase());
    if (!accountId) throw new AttestedRefusal('unknown-account', 'No account for that email yet.');
    return users.setUserEnabled(accountId, enabled);
  }

  function setOutage(on) {
    outage = Boolean(on);
    if (outage) fake.failAction('AdminInitiateAuth', 'InternalErrorException');
    else fake.clearFailures();
    return { outage };
  }

  function describe() {
    return {
      endpoint: fake.endpoint,
      userPoolId: pool.userPoolId,
      clientId: pool.clientId,
      issuer: pool.issuer,
      outage,
      poolSettings: fake.pools().find((entry) => entry.id === pool.userPoolId),
    };
  }

  return {
    requestLink,
    redeem,
    session,
    logout,
    setEnabled,
    setOutage,
    describe,
    close: () => fake.close(),
  };
}

const COOKIE = 'smoke_attested';

function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/**
 * Browser routes for the demo. Mutating routes take JSON only, so a cross-site form post
 * cannot reach them without a CORS preflight this app never answers.
 */
export function registerAttestedRoutes(app, demo) {
  const json = (req, reply) => {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      reply.code(415).send({ error: 'json-only' });
      return false;
    }
    return true;
  };
  const refusal = (reply, error) => {
    if (error instanceof AttestedRefusal) return reply.code(400).send({ error: error.reason, message: error.message });
    throw error;
  };

  app.post('/attested/request', async (req, reply) => {
    if (!json(req, reply)) return;
    try {
      const { link, expiresInSeconds } = demo.requestLink(req.body?.email);
      return { link, expiresInSeconds };
    } catch (error) {
      return refusal(reply, error);
    }
  });

  app.get('/attested/redeem', async (req, reply) => {
    try {
      const { sessionId } = await demo.redeem(req.query?.token);
      reply.header('set-cookie', `${COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/`);
      return reply.redirect('/#attested', 303);
    } catch (error) {
      const reason = error instanceof AttestedRefusal ? error.reason : 'unexpected';
      return reply.redirect(`/?attestedError=${encodeURIComponent(reason)}#attested`, 303);
    }
  });

  app.get('/attested/session', async (req) => demo.session(cookieValue(req.headers.cookie, COOKIE)));

  app.post('/attested/logout', async (req, reply) => {
    if (!json(req, reply)) return;
    demo.logout(cookieValue(req.headers.cookie, COOKIE));
    reply.header('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return { loggedOut: true };
  });

  app.post('/attested/admin', async (req, reply) => {
    if (!json(req, reply)) return;
    try {
      const { action, email } = req.body ?? {};
      if (action === 'disable') return demo.setEnabled(email, false);
      if (action === 'enable') return demo.setEnabled(email, true);
      if (action === 'outage-on') return demo.setOutage(true);
      if (action === 'outage-off') return demo.setOutage(false);
      return reply.code(400).send({ error: 'unknown-action' });
    } catch (error) {
      return refusal(reply, error);
    }
  });
}
