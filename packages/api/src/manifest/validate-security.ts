import type { ApiManifest, ApiManifestFinding } from './types.js';

function defaultSchemeName(manifest: ApiManifest): string | undefined {
  return manifest.identity?.defaultSecurityScheme ?? manifest.identity?.defaultAuth;
}

export function validateSecurityConfig(manifest: ApiManifest): ApiManifestFinding[] {
  const findings: ApiManifestFinding[] = [];
  const schemes = manifest.securitySchemes ?? {};
  const schemeNames = new Set(Object.keys(schemes));

  if (manifest.identity?.defaultAuth && !manifest.identity.defaultSecurityScheme) {
    findings.push({
      code: 'manifest.security.legacy-default-auth',
      severity: 'warning',
      message:
        'identity.defaultAuth is deprecated; use identity.defaultSecurityScheme and explicit securitySchemes instead',
    });
  }

  const defaultScheme = defaultSchemeName(manifest);
  if (defaultScheme && !schemeNames.has(defaultScheme)) {
    const legacyDefault =
      manifest.identity?.defaultAuth === defaultScheme && !manifest.identity.defaultSecurityScheme;
    findings.push({
      code: 'manifest.security.unknown-default-scheme',
      severity: legacyDefault ? 'warning' : 'error',
      message: `identity.defaultSecurityScheme "${defaultScheme}" is not defined in securitySchemes`,
    });
  }

  for (const [name, scheme] of Object.entries(schemes)) {
    if (scheme.type === 'oauth2') {
      const configuredFlows = Object.entries(scheme.flows).filter(([, flow]) => flow !== undefined);
      if (configuredFlows.length === 0) {
        findings.push({
          code: 'manifest.security.oauth2-missing-flow',
          message: `securitySchemes.${name} oauth2 requires at least one configured flow`,
        });
      }
      for (const [flowName, flow] of configuredFlows) {
        if (!flow.tokenUrl) {
          findings.push({
            code: 'manifest.security.oauth2-missing-token-url',
            message: `securitySchemes.${name} oauth2 ${flowName} flow requires an explicit tokenUrl`,
          });
        } else if (flow.tokenUrl === '/oauth/token') {
          findings.push({
            code: 'manifest.security.invented-token-url',
            message: `securitySchemes.${name} must not use invented tokenUrl "/oauth/token"; configure a real issuer token endpoint`,
          });
        }
      }
    }

    if (scheme.type === 'openIdConnect' && !scheme.openIdConnectUrl) {
      findings.push({
        code: 'manifest.security.oidc-missing-discovery-url',
        message: `securitySchemes.${name} openIdConnect requires openIdConnectUrl`,
      });
    }
  }

  for (const entry of manifest.expose) {
    const explicitSchemes = entry.auth?.scheme
      ? Array.isArray(entry.auth.scheme)
        ? entry.auth.scheme
        : [entry.auth.scheme]
      : [];
    for (const schemeRef of explicitSchemes) {
      if (!schemeNames.has(schemeRef)) {
        findings.push({
          code: 'manifest.security.unknown-scheme',
          message: `Exposure "${entry.operationId}" references unknown auth.scheme "${schemeRef}"`,
          operationId: entry.operationId,
          path: entry.path,
        });
      }
    }

    const defaultScheme = defaultSchemeName(manifest);
    const schemeName = explicitSchemes[0] ?? defaultScheme;

    const scopes = entry.auth?.scopes ?? [];
    if (scopes.length > 0 && !schemeName) {
      findings.push({
        code: 'manifest.security.scopes-without-scheme',
        message: `Exposure "${entry.operationId}" declares auth scopes but no auth.scheme or default security scheme`,
        operationId: entry.operationId,
        path: entry.path,
      });
    }

    if (schemeName && schemeNames.size > 0 && !schemeNames.has(schemeName)) {
      findings.push({
        code: 'manifest.security.unknown-scheme',
        message: `Exposure "${entry.operationId}" resolves to unknown security scheme "${schemeName}"`,
        operationId: entry.operationId,
        path: entry.path,
      });
    }
  }

  return findings;
}
