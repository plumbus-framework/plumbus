// ── Frontend Auth Helpers Generator ──
// Generates auth utilities from auth adapter config:
// login/logout, session hooks, route guards, tenant context, user identity hooks.

export type AuthTransport = 'session' | 'bearer';

export interface AuthHelperConfig {
  /** Auth provider type */
  provider: string;
  /** Credential transport — session (cookie + CSRF) or bearer (localStorage JWT) */
  transport?: AuthTransport;
  /** Token storage key (bearer transport only) */
  tokenKey?: string;
  /** Login endpoint (bearer transport) */
  loginEndpoint?: string;
  /** Logout endpoint */
  logoutEndpoint?: string;
  /** Session refresh endpoint (bearer transport) */
  refreshEndpoint?: string;
  /** Session state endpoint (session transport) */
  sessionEndpoint?: string;
  /** Provider discovery endpoint (session transport) */
  providersEndpoint?: string;
  /** Include tenant context provider */
  multiTenant?: boolean;
}

let transportWarningEmitted = false;

/** Reset deprecation warning state — for tests only. */
export function __resetTransportWarningForTests(): void {
  transportWarningEmitted = false;
}

function resolveTransport(config?: AuthHelperConfig): AuthTransport {
  if (config?.transport) {
    return config.transport;
  }
  if (!transportWarningEmitted) {
    transportWarningEmitted = true;
    console.warn(
      '[@plumbus/ui] Auth transport omitted; defaulting to bearer (deprecated). Pass transport: "session" or transport: "bearer" explicitly.',
    );
  }
  return 'bearer';
}

// ── Auth Types Generator ──

/** Generate TypeScript types for auth state */
export function generateAuthTypes(transport: AuthTransport = 'bearer'): string {
  const providerInfo =
    transport === 'session'
      ? `
export interface AuthProviderInfo {
  id: string;
  label: string;
  loginUrl: string;
  available: boolean;
}

export interface SessionResponse {
  authenticated: boolean;
  user?: AuthUser;
  csrfToken?: string;
  expiresAt?: string;
}`
      : '';

  return `export interface AuthUser {
  userId: string;
  roles: string[];
  scopes: string[];
  tenantId?: string;
  provider: string;
  sessionId?: string;
  providerId?: string;
  authenticatedAt?: string;
}

export interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: Error | null;
}

export interface AuthActions {
  login(credentials: LoginCredentials): Promise<void>;
  logout(): Promise<void>;
  refreshSession(): Promise<void>;
  getToken(): string | null;
}

export interface LoginCredentials {
  email?: string;
  password?: string;
  token?: string;
  provider?: string;
}

export interface AuthConfig {
  loginEndpoint: string;
  logoutEndpoint: string;
  refreshEndpoint: string;
  tokenKey: string;
}${providerInfo}`;
}

// ── Token Management (bearer) ──

/** Generate token storage utilities for bearer transport */
export function generateTokenUtils(config?: AuthHelperConfig): string {
  const key = config?.tokenKey ?? 'plumbus_auth_token';

  return `const TOKEN_KEY = "${key}";

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
}

export function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string): boolean {
  const payload = parseJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return true;
  return payload.exp * 1000 < Date.now();
}`;
}

// ── CSRF + session helpers (session transport) ──

/** Map auth callback error codes (§15.4) to user-facing copy for generated login surfaces. */
export function generateAuthErrorMessages(): string {
  return `export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  login_failed: "Sign-in failed. Please try again.",
  login_cancelled: "Sign-in was cancelled.",
  provider_unavailable: "The sign-in provider is temporarily unavailable.",
};

export function authErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return AUTH_ERROR_MESSAGES[code] ?? "Sign-in failed. Please try again.";
}`;
}

/** Generate in-memory CSRF utilities for session transport */
export function generateCsrfUtils(): string {
  return `let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function csrfHeaders(method: string): Record<string, string> {
  if (!csrfToken || !UNSAFE_METHODS.has(method.toUpperCase())) return {};
  return { "X-CSRF-Token": csrfToken };
}`;
}

/** Generate session transport auth functions */
export function generateSessionAuthFunctions(config?: AuthHelperConfig): string {
  const sessionUrl = config?.sessionEndpoint ?? '/auth/session';
  const logoutUrl = config?.logoutEndpoint ?? '/auth/logout';
  const providersUrl = config?.providersEndpoint ?? '/auth/providers';

  return `export async function fetchProviders(): Promise<AuthProviderInfo[]> {
  const response = await fetch("${providersUrl}", { credentials: "include" });
  if (!response.ok) {
    throw new Error("Failed to load auth providers");
  }
  const data = await response.json() as { providers?: AuthProviderInfo[] };
  return data.providers ?? [];
}

export function startLogin(providerId: string, returnTo?: string): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams();
  if (returnTo) params.set("returnTo", returnTo);
  const qs = params.toString();
  const url = qs ? \`/auth/login/\${encodeURIComponent(providerId)}?\${qs}\` : \`/auth/login/\${encodeURIComponent(providerId)}\`;
  window.location.assign(url);
}

export async function loadSession(): Promise<AuthUser | null> {
  const response = await fetch("${sessionUrl}", { credentials: "include" });
  if (!response.ok) {
    setCsrfToken(null);
    return null;
  }
  const data = await response.json() as SessionResponse;
  if (!data.authenticated || !data.user) {
    setCsrfToken(null);
    return null;
  }
  setCsrfToken(data.csrfToken ?? null);
  return data.user;
}

export async function login(credentials: LoginCredentials): Promise<AuthUser> {
  if (credentials.provider) {
    startLogin(credentials.provider);
    throw new Error("Redirecting to login provider");
  }
  throw new Error("Session transport requires a provider id for login");
}

export async function logout(): Promise<void> {
  const response = await fetch("${logoutUrl}", {
    method: "POST",
    credentials: "include",
    headers: { ...csrfHeaders("POST") },
  }).catch(() => undefined);
  setCsrfToken(null);
  if (response?.ok) {
    const data = await response.json().catch(() => ({})) as { providerLogoutUrl?: string };
    if (data.providerLogoutUrl && typeof window !== "undefined") {
      window.location.assign(data.providerLogoutUrl);
    }
  }
}

export async function refreshSession(): Promise<AuthUser | null> {
  return loadSession();
}

export function getStoredToken(): string | null {
  return null;
}

export function getAuthHeaders(method = "GET"): Record<string, string> {
  return csrfHeaders(method);
}`;
}

// ── Login/Logout Functions (bearer) ──

/** Generate login/logout functions for bearer transport */
export function generateBearerAuthFunctions(config?: AuthHelperConfig): string {
  const loginUrl = config?.loginEndpoint ?? '/api/auth/login';
  const logoutUrl = config?.logoutEndpoint ?? '/api/auth/logout';
  const refreshUrl = config?.refreshEndpoint ?? '/api/auth/refresh';

  return `export async function login(credentials: LoginCredentials): Promise<AuthUser> {
  const response = await fetch("${loginUrl}", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message ?? "Login failed");
  }
  const data = await response.json() as { token: string; user: AuthUser };
  setStoredToken(data.token);
  return data.user;
}

export async function logout(): Promise<void> {
  const token = getStoredToken();
  if (token) {
    await fetch("${logoutUrl}", {
      method: "POST",
      headers: { Authorization: \`Bearer \${token}\` },
    }).catch(() => {});
  }
  clearStoredToken();
}

export async function refreshSession(): Promise<AuthUser | null> {
  const token = getStoredToken();
  if (!token) return null;
  const response = await fetch("${refreshUrl}", {
    method: "POST",
    headers: { Authorization: \`Bearer \${token}\` },
  });
  if (!response.ok) {
    clearStoredToken();
    return null;
  }
  const data = await response.json() as { token: string; user: AuthUser };
  setStoredToken(data.token);
  return data.user;
}

export function getAuthHeaders(): Record<string, string> {
  const token = getStoredToken();
  return token ? { Authorization: \`Bearer \${token}\` } : {};
}`;
}

/** Generate login/logout functions for the selected transport */
export function generateAuthFunctions(config?: AuthHelperConfig): string {
  const transport = resolveTransport(config);
  return transport === 'session'
    ? generateSessionAuthFunctions(config)
    : generateBearerAuthFunctions(config);
}

// ── React Hooks ──

/** Generate useAuth React hook */
export function generateUseAuthHook(transport: AuthTransport = 'bearer'): string {
  const mountEffect =
    transport === 'session'
      ? `    loadSession()
      .then((user) => {
        setState({
          user,
          isAuthenticated: !!user,
          isLoading: false,
          error: null,
        });
      })`
      : `    const token = getStoredToken();
    if (!token || isTokenExpired(token)) {
      setState({ user: null, isAuthenticated: false, isLoading: false, error: null });
      return;
    }
    refreshSession()
      .then((user) => {
        setState({
          user,
          isAuthenticated: !!user,
          isLoading: false,
          error: null,
        });
      })`;

  const getTokenFn = transport === 'session' ? 'getStoredToken' : 'getStoredToken';

  return `export function useAuth(): AuthState & AuthActions {
  const [state, setState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
    isLoading: true,
    error: null,
  });

  useEffect(() => {
${mountEffect}
      .catch((err) => {
        setState({
          user: null,
          isAuthenticated: false,
          isLoading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
  }, []);

  return {
    ...state,
    login: async (credentials) => {
      setState((s) => ({ ...s, isLoading: true, error: null }));
      try {
        const user = await login(credentials);
        setState({ user, isAuthenticated: true, isLoading: false, error: null });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setState((s) => ({ ...s, isLoading: false, error }));
        throw error;
      }
    },
    logout: async () => {
      await logout();
      setState({ user: null, isAuthenticated: false, isLoading: false, error: null });
    },
    refreshSession: async () => {
      const user = await refreshSession();
      setState({
        user,
        isAuthenticated: !!user,
        isLoading: false,
        error: null,
      });
    },
    getToken: ${getTokenFn},
  };
}`;
}

/** Generate useCurrentUser hook */
export function generateUseCurrentUserHook(): string {
  return `export function useCurrentUser() {
  const { user, isAuthenticated, isLoading } = useAuth();
  return { user, isAuthenticated, isLoading };
}`;
}

// ── Route Guard ──

/** Generate route guard component code */
export function generateRouteGuard(): string {
  return `export interface RouteGuardProps {
  children: React.ReactNode;
  roles?: string[];
  scopes?: string[];
  fallback?: React.ReactNode;
  redirectTo?: string;
}

export function RouteGuard({ children, roles, scopes, fallback, redirectTo }: RouteGuardProps) {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (isLoading) return fallback ?? null;

  if (!isAuthenticated) {
    if (redirectTo && typeof window !== "undefined") {
      window.location.href = redirectTo;
      return null;
    }
    return fallback ?? null;
  }

  if (roles && roles.length > 0 && user) {
    const hasRole = roles.some((r) => user.roles.includes(r));
    if (!hasRole) return fallback ?? null;
  }

  if (scopes && scopes.length > 0 && user) {
    const hasScope = scopes.some((s) => user.scopes.includes(s));
    if (!hasScope) return fallback ?? null;
  }

  return children;
}`;
}

// ── Tenant Context ──

/** Generate tenant context provider */
export function generateTenantContext(): string {
  return `export interface TenantContextValue {
  tenantId: string | null;
  setTenantId(id: string): void;
}

export function useTenant(): TenantContextValue {
  const { user } = useAuth();
  const [tenantId, setTenantId] = useState<string | null>(user?.tenantId ?? null);

  useEffect(() => {
    if (user?.tenantId) setTenantId(user.tenantId);
  }, [user?.tenantId]);

  return { tenantId, setTenantId };
}`;
}

// ── Full Auth Module Generator ──

/** Generate a complete auth helpers module */
export function generateAuthModule(config?: AuthHelperConfig): string {
  const transport = resolveTransport(config);
  const lines: string[] = [
    '// Auto-generated by @plumbus/ui — do not edit',
    '// eslint-disable-next-line @typescript-eslint/no-unused-vars',
    'import React, { useState, useEffect } from "react";',
    '',
    generateAuthTypes(transport),
    '',
  ];

  if (transport === 'session') {
    lines.push(generateAuthErrorMessages());
    lines.push('');
    lines.push(generateCsrfUtils());
    lines.push('');
    lines.push(generateSessionAuthFunctions(config));
  } else {
    lines.push(generateTokenUtils(config));
    lines.push('');
    lines.push(generateBearerAuthFunctions(config));
  }

  lines.push('');
  lines.push(generateUseAuthHook(transport));
  lines.push('');
  lines.push(generateUseCurrentUserHook());
  lines.push('');
  lines.push(generateRouteGuard());
  lines.push('');

  if (config?.multiTenant) {
    lines.push(generateTenantContext());
    lines.push('');
  }

  return lines.join('\n');
}
