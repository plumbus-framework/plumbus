import { describe, expect, it } from "vitest";
import type { AuthHelperConfig } from "../auth-generator.js";
import {
    generateAuthFunctions,
    generateAuthModule,
    generateAuthTypes,
    generateRouteGuard,
    generateTenantContext,
    generateTokenUtils,
    generateUseAuthHook,
    generateUseCurrentUserHook,
} from "../auth-generator.js";

// ── generateAuthTypes ──

describe("generateAuthTypes", () => {
  it("generates AuthUser interface", () => {
    const code = generateAuthTypes();
    expect(code).toContain("export interface AuthUser");
    expect(code).toContain("userId: string");
    expect(code).toContain("roles: string[]");
    expect(code).toContain("scopes: string[]");
    expect(code).toContain("tenantId?: string");
    expect(code).toContain("provider: string");
  });

  it("generates AuthState interface", () => {
    const code = generateAuthTypes();
    expect(code).toContain("export interface AuthState");
    expect(code).toContain("user: AuthUser | null");
    expect(code).toContain("isAuthenticated: boolean");
    expect(code).toContain("isLoading: boolean");
    expect(code).toContain("error: Error | null");
  });

  it("generates LoginCredentials interface", () => {
    const code = generateAuthTypes();
    expect(code).toContain("export interface LoginCredentials");
    expect(code).toContain("email?: string");
    expect(code).toContain("password?: string");
  });

  it("generates AuthActions interface", () => {
    const code = generateAuthTypes();
    expect(code).toContain("export interface AuthActions");
    expect(code).toContain("login(credentials: LoginCredentials): Promise<void>");
    expect(code).toContain("logout(): Promise<void>");
    expect(code).toContain("refreshSession(): Promise<void>");
    expect(code).toContain("getToken(): string | null");
  });
});

// ── generateTokenUtils ──

describe("generateTokenUtils", () => {
  it("generates token storage functions", () => {
    const code = generateTokenUtils();
    expect(code).toContain("export function getStoredToken");
    expect(code).toContain("export function setStoredToken");
    expect(code).toContain("export function clearStoredToken");
    expect(code).toContain("localStorage");
  });

  it("uses default token key", () => {
    const code = generateTokenUtils();
    expect(code).toContain('TOKEN_KEY = "plumbus_auth_token"');
  });

  it("uses custom token key from config", () => {
    const code = generateTokenUtils({ provider: "jwt", tokenKey: "my_app_token" });
    expect(code).toContain('TOKEN_KEY = "my_app_token"');
  });

  it("generates JWT parsing utility", () => {
    const code = generateTokenUtils();
    expect(code).toContain("export function parseJwtPayload");
    expect(code).toContain("atob");
  });

  it("generates token expiration check", () => {
    const code = generateTokenUtils();
    expect(code).toContain("export function isTokenExpired");
    expect(code).toContain("payload.exp");
    expect(code).toContain("Date.now()");
  });
});

// ── generateAuthFunctions ──

describe("generateAuthFunctions", () => {
  it("generates login function", () => {
    const code = generateAuthFunctions();
    expect(code).toContain("export async function login");
    expect(code).toContain("LoginCredentials");
    expect(code).toContain("Promise<AuthUser>");
    expect(code).toContain("/api/auth/login");
  });

  it("generates logout function", () => {
    const code = generateAuthFunctions();
    expect(code).toContain("export async function logout");
    expect(code).toContain("/api/auth/logout");
    expect(code).toContain("clearStoredToken");
  });

  it("generates refresh function", () => {
    const code = generateAuthFunctions();
    expect(code).toContain("export async function refreshSession");
    expect(code).toContain("/api/auth/refresh");
    expect(code).toContain("AuthUser | null");
  });

  it("generates getAuthHeaders function", () => {
    const code = generateAuthFunctions();
    expect(code).toContain("export function getAuthHeaders");
    expect(code).toContain("Authorization");
    expect(code).toContain("Bearer");
  });

  it("uses custom endpoints from config", () => {
    const config: AuthHelperConfig = {
      provider: "jwt",
      loginEndpoint: "/auth/signin",
      logoutEndpoint: "/auth/signout",
      refreshEndpoint: "/auth/renew",
    };
    const code = generateAuthFunctions(config);
    expect(code).toContain("/auth/signin");
    expect(code).toContain("/auth/signout");
    expect(code).toContain("/auth/renew");
  });
});

// ── generateUseAuthHook ──

describe("generateUseAuthHook", () => {
  it("generates useAuth hook", () => {
    const code = generateUseAuthHook();
    expect(code).toContain("export function useAuth(): AuthState & AuthActions");
    expect(code).toContain("useState");
    expect(code).toContain("useEffect");
  });

  it("initializes with loading state", () => {
    const code = generateUseAuthHook();
    expect(code).toContain("isLoading: true");
  });

  it("checks token on mount", () => {
    const code = generateUseAuthHook();
    expect(code).toContain("getStoredToken");
    expect(code).toContain("isTokenExpired");
    expect(code).toContain("refreshSession");
  });

  it("returns auth actions", () => {
    const code = generateUseAuthHook();
    expect(code).toContain("login:");
    expect(code).toContain("logout:");
    expect(code).toContain("refreshSession:");
    expect(code).toContain("getToken: getStoredToken");
  });
});

// ── generateUseCurrentUserHook ──

describe("generateUseCurrentUserHook", () => {
  it("generates useCurrentUser hook", () => {
    const code = generateUseCurrentUserHook();
    expect(code).toContain("export function useCurrentUser");
    expect(code).toContain("useAuth");
    expect(code).toContain("user, isAuthenticated, isLoading");
  });
});

// ── generateRouteGuard ──

describe("generateRouteGuard", () => {
  it("generates RouteGuard component", () => {
    const code = generateRouteGuard();
    expect(code).toContain("export function RouteGuard");
    expect(code).toContain("RouteGuardProps");
    expect(code).toContain("children");
  });

  it("supports role-based access", () => {
    const code = generateRouteGuard();
    expect(code).toContain("roles?: string[]");
    expect(code).toContain("user.roles.includes(r)");
  });

  it("supports scope-based access", () => {
    const code = generateRouteGuard();
    expect(code).toContain("scopes?: string[]");
    expect(code).toContain("user.scopes.includes(s)");
  });

  it("supports redirect", () => {
    const code = generateRouteGuard();
    expect(code).toContain("redirectTo?: string");
    expect(code).toContain("window.location.href = redirectTo");
  });

  it("supports fallback", () => {
    const code = generateRouteGuard();
    expect(code).toContain("fallback?: React.ReactNode");
    expect(code).toContain("fallback ?? null");
  });
});

// ── generateTenantContext ──

describe("generateTenantContext", () => {
  it("generates useTenant hook", () => {
    const code = generateTenantContext();
    expect(code).toContain("export function useTenant");
    expect(code).toContain("TenantContextValue");
    expect(code).toContain("tenantId");
    expect(code).toContain("setTenantId");
  });

  it("integrates with useAuth for initial tenant", () => {
    const code = generateTenantContext();
    expect(code).toContain("useAuth");
    expect(code).toContain("user?.tenantId");
  });
});

// ── generateAuthModule ──

describe("generateAuthModule", () => {
  it("generates a complete auth module", () => {
    const code = generateAuthModule();
    expect(code).toContain("Auto-generated by @plumbus/ui");
    expect(code).toContain("import React");
    expect(code).toContain("interface AuthUser");
    expect(code).toContain("function getStoredToken");
    expect(code).toContain("function login");
    expect(code).toContain("function useAuth");
    expect(code).toContain("function useCurrentUser");
    expect(code).toContain("function RouteGuard");
  });

  it("excludes tenant context by default", () => {
    const code = generateAuthModule();
    expect(code).not.toContain("function useTenant");
  });

  it("includes tenant context when multiTenant is true", () => {
    const code = generateAuthModule({ provider: "jwt", multiTenant: true });
    expect(code).toContain("function useTenant");
    expect(code).toContain("TenantContextValue");
  });

  it("respects custom config", () => {
    const config: AuthHelperConfig = {
      provider: "jwt",
      tokenKey: "custom_token",
      loginEndpoint: "/custom/login",
      logoutEndpoint: "/custom/logout",
      refreshEndpoint: "/custom/refresh",
    };
    const code = generateAuthModule(config);
    expect(code).toContain('TOKEN_KEY = "custom_token"');
    expect(code).toContain("/custom/login");
    expect(code).toContain("/custom/logout");
    expect(code).toContain("/custom/refresh");
  });
});
