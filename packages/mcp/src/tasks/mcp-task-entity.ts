import { defineEntity, field } from '@plumbus/core';

export const mcpTaskEntity = defineEntity({
  name: 'McpTask',
  description: 'MCP task state for kind:job capabilities exposed via MCP',
  tenantScoped: true,
  fields: {
    id: field.id(),
    userId: field.string(),
    capabilityName: field.string(),
    capabilityDomain: field.string(),
    status: field.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
    statusMessage: field.string({ optional: true }),
    payloadJson: field.json({ optional: true }),
    errorJson: field.json({ optional: true }),
    lastProgressJson: field.json({ optional: true }),
    progressToken: field.string({ optional: true }),
    ttlMs: field.number({ optional: true }),
    createdAt: field.timestamp({ default: () => new Date() }),
    updatedAt: field.timestamp({ default: () => new Date() }),
  },
});
