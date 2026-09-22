import { describe, expect, it } from 'vitest';
import { ApiManifestSchema } from '../schema.js';

describe('ApiManifestSchema securitySchemes', () => {
  it('rejects oauth2 schemes with empty flows', () => {
    const result = ApiManifestSchema.safeParse({
      apiVersion: 'plumbus.dev/v1',
      name: 'partner-api',
      basePath: '/api/v1',
      securitySchemes: {
        partnerOAuth: {
          type: 'oauth2',
          flows: {},
        },
      },
      expose: [],
    });
    expect(result.success).toBe(false);
  });
});
