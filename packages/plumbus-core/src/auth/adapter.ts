import type { AuthContext } from "../types/security.js";

/**
 * AuthAdapter normalizes an incoming request identity (e.g. a token)
 * into a standard AuthContext.
 */
export interface AuthAdapter {
  /**
   * Extract and verify credentials from the raw authorization header value.
   * Returns null if the token is missing or invalid.
   */
  authenticate(authorizationHeader: string | undefined): Promise<AuthContext | null>;
}

export interface JwtAdapterConfig {
  /** Secret key for HMAC or public key for RSA/EC verification */
  secret: string;
  /** Expected issuer (iss claim) */
  issuer?: string;
  /** Expected audience (aud claim) */
  audience?: string;
  /**
   * Map JWT claims to AuthContext fields.
   * Defaults: sub→userId, roles→roles, scope→scopes, tenant_id→tenantId
   */
  claimMapping?: Partial<JwtClaimMapping>;
}

export interface JwtClaimMapping {
  userId: string;
  roles: string;
  scopes: string;
  tenantId: string;
}

const defaultClaimMapping: JwtClaimMapping = {
  userId: "sub",
  roles: "roles",
  scopes: "scope",
  tenantId: "tenant_id",
};

/**
 * JWT-based auth adapter. Decodes and validates JWT tokens,
 * mapping claims to an AuthContext.
 *
 * Uses a simple base64url decode — for production, integrate
 * a proper JWT library (jose, jsonwebtoken) for full signature verification.
 * This provides the adapter contract + claim mapping logic.
 */
export function createJwtAdapter(config: JwtAdapterConfig): AuthAdapter {
  const mapping = { ...defaultClaimMapping, ...config.claimMapping };

  return {
    async authenticate(
      authorizationHeader: string | undefined,
    ): Promise<AuthContext | null> {
      if (!authorizationHeader) return null;

      const token = extractBearerToken(authorizationHeader);
      if (!token) return null;

      const payload = decodeJwtPayload(token);
      if (!payload) return null;

      // Validate issuer if configured
      if (config.issuer && payload["iss"] !== config.issuer) {
        return null;
      }

      // Validate audience if configured
      if (config.audience) {
        const aud = payload["aud"];
        const audiences = Array.isArray(aud) ? aud : [aud];
        if (!audiences.includes(config.audience)) {
          return null;
        }
      }

      // Check expiration
      const exp = payload["exp"];
      if (typeof exp === "number" && exp * 1000 < Date.now()) {
        return null;
      }

      // Map claims to AuthContext
      const rawRoles = payload[mapping.roles];
      const rawScopes = payload[mapping.scopes];

      return {
        userId: String(payload[mapping.userId] ?? ""),
        roles: Array.isArray(rawRoles)
          ? rawRoles.map(String)
          : typeof rawRoles === "string"
            ? rawRoles.split(",").map((s: string) => s.trim())
            : [],
        scopes: Array.isArray(rawScopes)
          ? rawScopes.map(String)
          : typeof rawScopes === "string"
            ? rawScopes.split(" ").filter(Boolean)
            : [],
        tenantId: payload[mapping.tenantId]
          ? String(payload[mapping.tenantId])
          : undefined,
        provider: "jwt",
        sessionId: payload["sid"] ? String(payload["sid"]) : undefined,
        authenticatedAt: payload["iat"]
          ? new Date((payload["iat"] as number) * 1000)
          : undefined,
      };
    },
  };
}

function extractBearerToken(header: string): string | null {
  if (header.startsWith("Bearer ")) {
    return header.slice(7);
  }
  return null;
}

function decodeJwtPayload(
  token: string,
): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const payload = parts[1]!;
    const decoded = Buffer.from(payload, "base64url").toString("utf-8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}
