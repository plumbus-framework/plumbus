import { isApiExposed, type CapabilityContract } from '@plumbus/core';
import { apiVersionFromManifest, joinApiPath } from '../manifest/api-version.js';
import { resolveExposure } from '../manifest/resolve.js';
import { requiredApiScopes } from '../manifest/scopes.js';
import { zodToOpenApiSchema } from '../openapi/zod-to-openapi-schema.js';
import type { ApiManifest } from '../manifest/types.js';

function findManifestEntry(manifest: ApiManifest, cap: CapabilityContract) {
  const key = `${cap.domain}.${cap.name}`;
  return manifest.expose.find((e) => e.capability === key);
}

function schemaTable(schema: Record<string, unknown>): string {
  const props = schema.properties as Record<string, { type?: string }> | undefined;
  if (!props) {
    return '_No properties_\n';
  }
  const rows = Object.entries(props).map(
    ([name, def]) => `| \`${name}\` | ${def.type ?? 'unknown'} |`,
  );
  return `| Field | Type |\n|-------|------|\n${rows.join('\n')}\n`;
}

export function generateApiDocs(
  caps: CapabilityContract[],
  manifest: ApiManifest,
): Map<string, string> {
  const files = new Map<string, string>();
  const apiVersion = apiVersionFromManifest(manifest);

  files.set(
    'overview.md',
    `# ${manifest.name}\n\nPartner API documentation.\n\n- Base path: \`${manifest.basePath}\`\n- API version: \`${apiVersion}\`\n`,
  );

  const authLines = [
    '# Authentication',
    '',
    manifest.identity?.defaultAuth
      ? `Default auth: **${manifest.identity.defaultAuth}**`
      : 'Authentication is required for all non-public endpoints.',
    '',
  ];
  if (manifest.policy?.tenantRouting?.mode === 'auth-context') {
    authLines.push(
      'Tenant scoping is derived from the authenticated API consumer.',
      'Do not send `orgId` or `tenantId` in request paths, query strings, or request bodies.',
      '',
    );
  }
  files.set('authentication.md', authLines.join('\n'));

  for (const cap of caps) {
    if (!isApiExposed(cap)) {
      continue;
    }
    const entry = findManifestEntry(manifest, cap);
    const resolved = resolveExposure(cap, entry);
    const fullPath = joinApiPath(manifest.basePath, resolved.path);
    const inputSchema = zodToOpenApiSchema(cap.input);
    const outputSchema = zodToOpenApiSchema(cap.output);

    const lines = [
      `# ${resolved.operationId}`,
      '',
      resolved.docs?.summary ? `${resolved.docs.summary}\n` : '',
      resolved.docs?.description ? `${resolved.docs.description}\n` : '',
      `## Request`,
      '',
      `- **Method:** \`${resolved.method}\``,
      `- **Path:** \`${fullPath}\``,
      (() => {
        const scopes = requiredApiScopes(resolved.auth?.scopes, cap.access?.scopes);
        return scopes.length > 0 ? `- **Scopes:** ${scopes.map((s) => `\`${s}\``).join(', ')}` : '';
      })(),
      '',
      '### Request schema',
      '',
      schemaTable(inputSchema),
      '### Response schema',
      '',
      schemaTable(outputSchema),
      '## Errors',
      '',
      '| Code | Description |',
      '|------|-------------|',
      '| `validation_failed` | Invalid request |',
      '| `unauthenticated` | Missing or invalid auth |',
      '| `forbidden` | Access denied |',
      '| `not_found` | Resource not found |',
      '| `internal_error` | Server error |',
      '',
    ];

    if (resolved.idempotency?.required) {
      const headerName = resolved.idempotency.header ?? 'Idempotency-Key';
      lines.push('## Idempotency', '', `Required header: \`${headerName}\``, '');
    }

    if (resolved.test?.enabled) {
      lines.push(
        '## Test mode',
        '',
        'Send header `X-Plumbus-Intent: test` to invoke test behavior.',
        `Supported modes: ${resolved.test.modes.map((m) => `\`${m}\``).join(', ')}.`,
        '',
      );
    }

    if (resolved.stability) {
      lines.push(`**Stability:** \`${resolved.stability}\``, '');
    }

    if (resolved.deprecation) {
      lines.push(
        '## Deprecation',
        '',
        resolved.deprecation.sunset ? `- Sunset: ${resolved.deprecation.sunset}` : '',
        resolved.deprecation.replacement
          ? `- Replacement: \`${resolved.deprecation.replacement}\``
          : '',
        '',
      );
    }

    files.set(`endpoints/${resolved.operationId}.md`, lines.filter(Boolean).join('\n'));
  }

  return files;
}
