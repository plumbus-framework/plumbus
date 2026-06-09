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

const ApiManifestEntrySchema = z
  .object({
    capability: z.string(),
    operationId: z.string(),
    method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
    path: z.string(),
    stability: z.enum(['experimental', 'beta', 'stable', 'deprecated', 'internal']).optional(),
    auth: z
      .object({
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
        defaultAuth: z.string().optional(),
      })
      .strict()
      .optional(),
    policy: ApiPolicySchema,
    expose: z.array(ApiManifestEntrySchema),
  })
  .strict();
