import type { AuthContext } from '../types/security.js';
import type { AuthAdapter } from './adapter.js';

export interface AuthenticationRequest {
  authorization?: string;
  cookies: Readonly<Record<string, string>>;
  method: string;
  path: string;
  origin?: string;
  csrfToken?: string;
}

export type AuthenticationResult =
  | { status: 'authenticated'; auth: AuthContext }
  | { status: 'anonymous'; clearSessionCookie?: boolean; clearCookieHeader?: string }
  | { status: 'invalid'; code: 'invalid_authorization' | 'csrf_failed' }
  | { status: 'unavailable'; code: 'authentication_unavailable' };

export interface RequestAuthenticator {
  authenticate(request: AuthenticationRequest): Promise<AuthenticationResult>;
}

function isAuthorizationPresent(authorization: string | undefined): boolean {
  return authorization !== undefined && authorization.trim().length > 0;
}

export function wrapAuthAdapter(adapter: AuthAdapter): RequestAuthenticator {
  return {
    async authenticate(request: AuthenticationRequest): Promise<AuthenticationResult> {
      if (!isAuthorizationPresent(request.authorization)) {
        return { status: 'anonymous' };
      }

      try {
        const auth = await adapter.authenticate(request.authorization);
        if (auth) {
          return { status: 'authenticated', auth };
        }
        return { status: 'invalid', code: 'invalid_authorization' };
      } catch {
        return { status: 'unavailable', code: 'authentication_unavailable' };
      }
    },
  };
}

export function createCompositeRequestAuthenticator(opts: {
  bearer?: AuthAdapter;
  session: RequestAuthenticator;
}): RequestAuthenticator {
  const bearerAuthenticator = opts.bearer ? wrapAuthAdapter(opts.bearer) : undefined;

  return {
    async authenticate(request: AuthenticationRequest): Promise<AuthenticationResult> {
      if (isAuthorizationPresent(request.authorization)) {
        if (!bearerAuthenticator) {
          return { status: 'invalid', code: 'invalid_authorization' };
        }
        return bearerAuthenticator.authenticate(request);
      }

      return opts.session.authenticate(request);
    },
  };
}
