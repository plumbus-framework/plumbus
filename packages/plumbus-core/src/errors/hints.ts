export const ErrorHints = {
  flowConditionSyntax:
    'Use state.field comparisons (e.g. state.amount > 100 or state.status === "paid"). ' +
    'Operators: === !== == != > < >= <= && || !. Legacy ctx.state.* is normalized to state.*. ' +
    'No method calls or arbitrary JS.',
  aiProviderEnv:
    'Only openai and anthropic are supported. For local Ollama use AI_OPENAI_BASE_URL with the openai provider.',
  envNotLoaded:
    'Skipped loading .env — not in a Plumbus project directory. Run from project root or use a project marker (config/app.config.ts).',
  pathOutsideProject: 'Path must be under project root',
  tenantContextRequired: 'Tenant context is required for this operation.',
} as const;

export const ErrorDocUrls = {
  flowConditions: '/docs/core-concepts/flows.md#conditional-step',
  aiIntegration: '/docs/ai/ai-integration.md',
  securityModel: '/docs/security/security-model.md',
} as const;
