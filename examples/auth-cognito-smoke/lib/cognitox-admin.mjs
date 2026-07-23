// Thin client for cognitox's cognito-idp JSON API (the same wire protocol as the
// real AWS Cognito Identity Provider service) plus idempotent provisioning of the
// fixtures a login flow needs: one confidential app client (with secret) and one
// confirmed user with a known password.
//
// cognitox has NO auth on its admin endpoints, so we just POST with the
// X-Amz-Target header. Every mutation is logged so nothing happens silently.

/**
 * Call a cognito-idp operation. Returns the parsed JSON body.
 * cognitox returns HTTP 200 with an `{ __type, message }` body for API errors,
 * so callers inspect `__type` rather than relying on status codes.
 */
export async function cognitoIdp(base, target, body) {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${target}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return json;
}

/** cognito-idp error type from a response body, or undefined. */
function errorType(body) {
  if (!body || typeof body.__type !== 'string') return undefined;
  // "...#UsernameExistsException" -> "UsernameExistsException"
  return body.__type.split('#').pop();
}

function assertOk(target, body) {
  const type = errorType(body);
  if (type) {
    throw new Error(`${target} failed: ${type} — ${body.message ?? ''}`.trim());
  }
  return body;
}

/** GET the OpenID discovery document from a cognitox base URL. */
export async function fetchDiscovery(base) {
  const url = `${base.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`discovery fetch failed (HTTP ${res.status}) at ${url}`);
  }
  return res.json();
}

/**
 * Ensure a user pool exists and return its id.
 * - If `poolId` is provided and exists, reuse it.
 * - Otherwise find a pool named `poolName`, or create one.
 *
 * @returns {Promise<string>} the resolved user pool id
 */
export async function ensurePool({ base, poolId, poolName, log = () => {} }) {
  if (poolId) {
    const desc = await cognitoIdp(base, 'DescribeUserPool', { UserPoolId: poolId });
    if (!errorType(desc)) {
      log(`reused user pool ${poolId}`);
      return poolId;
    }
    log(`requested pool ${poolId} not found — falling back to a pool named "${poolName}"`);
  }
  const list = assertOk('ListUserPools', await cognitoIdp(base, 'ListUserPools', { MaxResults: 60 }));
  const existing = (list.UserPools ?? []).find((p) => p.Name === poolName);
  if (existing) {
    log(`reused user pool "${poolName}" (${existing.Id})`);
    return existing.Id;
  }
  const created = assertOk(
    'CreateUserPool',
    await cognitoIdp(base, 'CreateUserPool', { PoolName: poolName }),
  );
  log(`created user pool "${poolName}" (${created.UserPool.Id})`);
  return created.UserPool.Id;
}

/**
 * Ensure a confidential app client exists with the OAuth settings this smoke
 * app needs, and that its callback / logout URLs match the running config.
 * Idempotent: reuses an existing client with the same name, refreshing its URLs.
 *
 * @returns {Promise<{ clientId: string, clientSecret: string, created: boolean }>}
 */
export async function ensureAppClient({
  base,
  poolId,
  clientName,
  callbackUrl,
  logoutUrl,
  log = () => {},
}) {
  const desired = {
    UserPoolId: poolId,
    ClientName: clientName,
    GenerateSecret: true,
    ExplicitAuthFlows: [
      'ALLOW_ADMIN_USER_PASSWORD_AUTH',
      'ALLOW_USER_PASSWORD_AUTH',
      'ALLOW_REFRESH_TOKEN_AUTH',
    ],
    AllowedOAuthFlows: ['code'],
    AllowedOAuthScopes: ['openid', 'email', 'profile'],
    AllowedOAuthFlowsUserPoolClient: true,
    CallbackURLs: [callbackUrl],
    LogoutURLs: [logoutUrl],
    SupportedIdentityProviders: ['COGNITO'],
  };

  const list = assertOk(
    'ListUserPoolClients',
    await cognitoIdp(base, 'ListUserPoolClients', { UserPoolId: poolId, MaxResults: 60 }),
  );
  const existing = (list.UserPoolClients ?? []).find((c) => c.ClientName === clientName);

  if (!existing) {
    const created = assertOk(
      'CreateUserPoolClient',
      await cognitoIdp(base, 'CreateUserPoolClient', desired),
    ).UserPoolClient;
    log(`created app client "${clientName}" (${created.ClientId})`);
    return { clientId: created.ClientId, clientSecret: created.ClientSecret, created: true };
  }

  // Refresh callback/logout URLs on the existing client so it matches this run.
  // Cognito's UpdateUserPoolClient replaces the whole config, so we send the
  // full desired shape (minus GenerateSecret, which is create-only).
  const { GenerateSecret: _drop, ...updatable } = desired;
  assertOk(
    'UpdateUserPoolClient',
    await cognitoIdp(base, 'UpdateUserPoolClient', {
      ...updatable,
      ClientId: existing.ClientId,
    }),
  );
  const described = assertOk(
    'DescribeUserPoolClient',
    await cognitoIdp(base, 'DescribeUserPoolClient', {
      UserPoolId: poolId,
      ClientId: existing.ClientId,
    }),
  ).UserPoolClient;
  log(`reused app client "${clientName}" (${existing.ClientId}); callback/logout URLs refreshed`);
  return { clientId: described.ClientId, clientSecret: described.ClientSecret, created: false };
}

/**
 * Ensure a confirmed user with a known permanent password exists.
 * Idempotent: tolerates UsernameExistsException, then (re)sets the password.
 *
 * @returns {Promise<{ username: string, sub?: string, created: boolean }>}
 */
export async function ensureUser({ base, poolId, username, password, email, log = () => {} }) {
  const create = await cognitoIdp(base, 'AdminCreateUser', {
    UserPoolId: poolId,
    Username: username,
    MessageAction: 'SUPPRESS',
    UserAttributes: [
      { Name: 'email', Value: email ?? username },
      { Name: 'email_verified', Value: 'true' },
    ],
  });
  const type = errorType(create);
  let created = false;
  if (type === 'UsernameExistsException') {
    log(`reused user "${username}"`);
  } else if (type) {
    throw new Error(`AdminCreateUser failed: ${type} — ${create.message ?? ''}`.trim());
  } else {
    created = true;
    log(`created user "${username}"`);
  }

  assertOk(
    'AdminSetUserPassword',
    await cognitoIdp(base, 'AdminSetUserPassword', {
      UserPoolId: poolId,
      Username: username,
      Password: password,
      Permanent: true,
    }),
  );

  // Best-effort: read back the immutable sub for display / identity checks.
  let sub;
  try {
    const got = await cognitoIdp(base, 'AdminGetUser', { UserPoolId: poolId, Username: username });
    sub = (got.UserAttributes ?? []).find((a) => a.Name === 'sub')?.Value;
  } catch {
    // non-fatal
  }
  return { username, sub, created };
}
