import type { BrowserExtensionScaffoldConfig, GeneratedFile } from '../types.js';
import { EDITABLE_HEADER } from './constants.js';

export function generateAuthStore(config: BrowserExtensionScaffoldConfig): GeneratedFile {
  const base = config.apiBaseUrl.replace(/\/$/, '');
  return {
    path: 'src/auth-store.ts',
    content: `${EDITABLE_HEADER}
const API_BASE_URL = ${JSON.stringify(base)};
const TOKEN_STORAGE_KEY = 'plumbus_auth_token';
const USER_STORAGE_KEY = 'plumbus_auth_user';

export type AuthState =
  | { status: 'anonymous' }
  | { status: 'authenticated'; token: string; user?: unknown }
  | { status: 'expired'; token: string; user?: unknown }
  | { status: 'refreshing'; token: string; user?: unknown }
  | { status: 'error'; reason: string };

async function readStorage(): Promise<{ token?: string; user?: unknown }> {
  const data = await browser.storage.local.get([TOKEN_STORAGE_KEY, USER_STORAGE_KEY]);
  const token = data[TOKEN_STORAGE_KEY];
  const user = data[USER_STORAGE_KEY];
  return {
    token: typeof token === 'string' ? token : undefined,
    user,
  };
}

export async function getAuthState(): Promise<AuthState> {
  const { token, user } = await readStorage();
  if (!token) return { status: 'anonymous' };
  return { status: 'authenticated', token, user };
}

export async function setAuthToken(token: string, user?: unknown): Promise<void> {
  await browser.storage.local.set({
    [TOKEN_STORAGE_KEY]: token,
    ...(user !== undefined ? { [USER_STORAGE_KEY]: user } : {}),
  });
}

export async function clearAuth(): Promise<void> {
  await browser.storage.local.remove([TOKEN_STORAGE_KEY, USER_STORAGE_KEY]);
}

export async function authHeaders(): Promise<Record<string, string>> {
  const { token } = await readStorage();
  return token ? { Authorization: \`Bearer \${token}\` } : {};
}

/** Coalesce concurrent refresh calls (avoids double-refresh on rotating backends). */
let refreshInFlight: Promise<AuthState> | null = null;

async function refreshAuthOnce(): Promise<AuthState> {
  const { token, user } = await readStorage();
  if (!token) return { status: 'anonymous' };

  const response = await fetch(\`\${API_BASE_URL}/api/auth/refresh\`, {
    method: 'POST',
    headers: { Authorization: \`Bearer \${token}\` },
  });

  if (!response.ok) {
    await clearAuth();
    return { status: 'expired', token, user };
  }

  const data = (await response.json()) as { token: string; user?: unknown };
  await setAuthToken(data.token, data.user ?? user);
  return { status: 'authenticated', token: data.token, user: data.user ?? user };
}

export async function refreshAuth(): Promise<AuthState> {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  refreshInFlight = refreshAuthOnce().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export async function logout(): Promise<void> {
  const headers = await authHeaders();
  try {
    await fetch(\`\${API_BASE_URL}/api/auth/logout\`, {
      method: 'POST',
      headers,
    });
  } catch {
    // best-effort
  }
  await clearAuth();
}
`,
  };
}
