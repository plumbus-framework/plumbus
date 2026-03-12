// ── Frontend Auth Helpers Generator ──
// Generates auth utilities from auth adapter config:
// login/logout, session hooks, route guards, tenant context, user identity hooks.

export interface AuthHelperConfig {
  /** Auth provider type */
  provider: string;
  /** Token storage key */
  tokenKey?: string;
  /** Login endpoint */
  loginEndpoint?: string;
  /** Logout endpoint */
  logoutEndpoint?: string;
  /** Session refresh endpoint */
  refreshEndpoint?: string;
  /** Include tenant context provider */
  multiTenant?: boolean;
}

// ── Auth Types Generator ──

/** Generate TypeScript types for auth state */
export function generateAuthTypes(): string {
  return `export interface AuthUser {
  userId: string;
  roles: string[];
  scopes: string[];
  tenantId?: string;
  provider: string;
  sessionId?: string;
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
}`;
}

// ── Token Management ──

/** Generate token storage utilities */
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
    const payload = parts[1]!;
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

// ── Login/Logout Functions ──

/** Generate login/logout functions */
export function generateAuthFunctions(config?: AuthHelperConfig): string {
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

// ── React Hooks ──

/** Generate useAuth React hook */
export function generateUseAuthHook(): string {
  return `export function useAuth(): AuthState & AuthActions {
  const [state, setState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
    isLoading: true,
    error: null,
  });

  useEffect(() => {
    const token = getStoredToken();
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
      })
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
    getToken: getStoredToken,
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
  const lines: string[] = [
    '// Auto-generated by @plumbus/ui — do not edit',
    '// eslint-disable-next-line @typescript-eslint/no-unused-vars',
    'import React, { useState, useEffect } from "react";',
    '',
    generateAuthTypes(),
    '',
    generateTokenUtils(config),
    '',
    generateAuthFunctions(config),
    '',
    generateUseAuthHook(),
    '',
    generateUseCurrentUserHook(),
    '',
    generateRouteGuard(),
    '',
  ];

  if (config?.multiTenant) {
    lines.push(generateTenantContext());
    lines.push('');
  }

  return lines.join('\n');
}
