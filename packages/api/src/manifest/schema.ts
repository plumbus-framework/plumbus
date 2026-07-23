import { z } from 'zod';

const ApiPolicySchema = z
  .object({
    tenantRouting: z
      .object({
        mode: z.enum(['auth-context', 'path-prefix']),
        forbidExplicitTenantInput: z.boolean().optional(),
        forbiddenParams: z
          .object({
            path: z.array(z.string()).optional(),
            query: z.array(z.string()).optional(),
            body: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        prefix: z.string().optional(),
        paramName: z.string().optional(),
      })
      .strict()
      .optional(),
    methodSemantics: z
      .object({
        forbidMutationOverGet: z.boolean().optional(),
        forbidGetBody: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const HttpSecuritySchemeSchema = z
  .object({
    type: z.literal('http'),
    scheme: z.string(),
    bearerFormat: z.string().optional(),
  })
  .strict();

const ApiKeySecuritySchemeSchema = z
  .object({
    type: z.literal('apiKey'),
    in: z.enum(['cookie', 'header', 'query']),
    name: z.string(),
    'x-plumbus-csrf': z
      .object({
        unsafeMethods: z.array(z.enum(['POST', 'PUT', 'PATCH', 'DELETE'])),
        headerName: z.string(),
        tokenEndpoint: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

const OAuth2FlowSchema = z
  .object({
    tokenUrl: z.string(),
    scopes: z.record(z.string()).optional(),
    authorizationUrl: z.string().optional(),
    refreshUrl: z.string().optional(),
  })
  .strict();

const OAuth2SecuritySchemeSchema = z
  .object({
    type: z.literal('oauth2'),
    flows: z
      .object({
        clientCredentials: OAuth2FlowSchema.optional(),
        authorizationCode: OAuth2FlowSchema.optional(),
        implicit: OAuth2FlowSchema.optional(),
        password: OAuth2FlowSchema.optional(),
      })
      .strict(),
  })
  .strict();

const OpenIdConnectSecuritySchemeSchema = z
  .object({
    type: z.literal('openIdConnect'),
    openIdConnectUrl: z.string(),
  })
  .strict();

export const SecuritySchemeSchema = z.discriminatedUnion('type', [
  HttpSecuritySchemeSchema,
  ApiKeySecuritySchemeSchema,
  OAuth2SecuritySchemeSchema,
  OpenIdConnectSecuritySchemeSchema,
]);

export type SecurityScheme = z.infer<typeof SecuritySchemeSchema>;

const ApiManifestEntrySchema = z
  .object({
    capability: z.string(),
    operationId: z.string(),
    method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
    path: z.string(),
    stability: z.enum(['experimental', 'beta', 'stable', 'deprecated', 'internal']).optional(),
    auth: z
      .object({
        scheme: z.union([z.string(), z.array(z.string().min(1)).min(1)]).optional(),
        scopes: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    idempotency: z
      .object({
        required: z.boolean(),
        header: z.string(),
        ttl: z.string().optional(),
      })
      .strict()
      .optional(),
    test: z
      .object({
        enabled: z.boolean(),
        modes: z.array(z.enum(['validate-only', 'safe-reply'])),
        defaultMode: z.enum(['validate-only', 'safe-reply']).optional(),
        safeReply: z
          .object({
            fixture: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    docs: z
      .object({
        summary: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    deprecation: z
      .object({
        sunset: z.string().optional(),
        replacement: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ApiManifestSchema = z
  .object({
    apiVersion: z.string(),
    name: z.string(),
    basePath: z.string(),
    identity: z
      .object({
        audience: z.string().optional(),
        /** @deprecated Use defaultSecurityScheme */
        defaultAuth: z.string().optional(),
        defaultSecurityScheme: z.string().optional(),
      })
      .strict()
      .optional(),
    securitySchemes: z.record(SecuritySchemeSchema).optional(),
    policy: ApiPolicySchema,
    expose: z.array(ApiManifestEntrySchema),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    for (const [name, scheme] of Object.entries(manifest.securitySchemes ?? {})) {
      if (scheme.type !== 'oauth2') {
        continue;
      }
      const configuredFlows = Object.values(scheme.flows).filter(Boolean);
      if (configuredFlows.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['securitySchemes', name, 'flows'],
          message: 'oauth2 security scheme requires at least one configured flow',
        });
      }
    }
  });
