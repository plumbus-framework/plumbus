import type { AuthRuntimeConfig } from '../config/types.js';
import { validateAuthRuntimeConfig } from '../config/validate.js';

export interface AuthDiagnosticFinding {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

export interface AuthDiagnosticsReport {
  findings: AuthDiagnosticFinding[];
}

export function runAuthDiagnostics(config: AuthRuntimeConfig): AuthDiagnosticsReport {
  const findings: AuthDiagnosticFinding[] = [];
  try {
    const normalized = validateAuthRuntimeConfig(config);
    if (normalized.externalBaseUrl.origin !== normalized.applicationBaseUrl.origin) {
      findings.push({
        level: 'error',
        code: 'cross_site_deployment',
        message:
          'applicationBaseUrl and externalBaseUrl are cross-site; cookie sessions require same-site deployment or bearer transport',
      });
    }
    if (normalized.environment === 'production') {
      if (normalized.externalBaseUrl.protocol !== 'https:') {
        findings.push({
          level: 'error',
          code: 'non_https_external',
          message: 'externalBaseUrl must use HTTPS in production',
        });
      }
      if (!normalized.session.cookieName.startsWith('__Host-')) {
        findings.push({
          level: 'error',
          code: 'cookie_prefix',
          message: 'session cookie must use __Host- prefix in production',
        });
      }
    }
    for (const [id, provider] of Object.entries(normalized.providers)) {
      const extraScopes = provider.scopes.filter(
        (s) => !['openid', 'profile', 'email'].includes(s),
      );
      if (extraScopes.length > 0 && !provider.fetchUserInfo) {
        findings.push({
          level: 'warning',
          code: 'scopes_without_consumer',
          message: `Provider "${id}" requests API scopes without fetchUserInfo enabled`,
        });
      }
    }
  } catch (error) {
    findings.push({
      level: 'error',
      code: 'invalid_config',
      message: error instanceof Error ? error.message : 'Invalid configuration',
    });
  }

  findings.push({
    level: 'info',
    code: 'no_rate_limit',
    message: 'IP/network rate limiting for /auth/* is the application or edge responsibility',
  });

  return { findings };
}
