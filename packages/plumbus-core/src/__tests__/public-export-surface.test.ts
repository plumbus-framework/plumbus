import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '../index.js';
import * as runtimeSeam from '../runtime-entry.js';
import * as testing from '../testing/index.js';

// ════════════════════════════════════════════════════════════════════════════
// Export-surface snapshot.
//
// `PUBLIC_EXPORTS` is the exact, sorted list of value exports reachable through
// the `@plumbus/core` root entry point. It is a deliberate tripwire, not
// bookkeeping: a name can only enter or leave the framework's public surface
// through an edit to this list, reviewed on its own terms.
//
// Adding a public export is legitimate — append the name here in sorted order
// in the same change. Deleting one is a breaking change for consumers and needs
// a major version bump.
//
// `SEAM_ONLY` names must never appear on the root or `./testing` entry points.
// `createExecutionContext` mints the platform-established actor; anything that
// can call it can fabricate one, so ordinary application code — which imports
// `@plumbus/core` — cannot reach it. It stays available to runtime hosts (the
// transport packages, and an application's own server bootstrap) through the
// `@plumbus/core/runtime` seam, and to tests through the sanctioned testing
// helpers (`createTestContext`, `runCapability`).
// ════════════════════════════════════════════════════════════════════════════

const PUBLIC_EXPORTS: readonly string[] = [
  'AIBudgetExceededError',
  'AIIncompleteOutputError',
  'AIInvalidRequestError',
  'AIRefusalError',
  'AISecurityBlockedError',
  'BackoffStrategy',
  'CapabilityKind',
  'CapabilityRegistry',
  'ConsumerRegistry',
  'DEFAULT_CORE_SCHEMA',
  'DEFAULT_DATA_PLANE_CACHE_SIZE',
  'DEFAULT_DATA_PLANE_POOL_SIZE',
  'DEFAULT_PACKAGE_SCHEMA_PREFIX',
  'DataForbiddenError',
  'DataInternalError',
  'DataPlaneConnectionError',
  'DataPlaneGuardError',
  'DataPlaneNameError',
  'DataPlaneProvisioningError',
  'DataValidationError',
  'ENCRYPTION_PREFIX',
  'EncryptionConfigError',
  'EncryptionPayloadError',
  'EntityRegistry',
  'ErrorCode',
  'EventRegistry',
  'FieldClassification',
  'FlowCancelledError',
  'FlowRegistry',
  'FlowStatus',
  'FlowStepType',
  'GovernanceSeverity',
  'JobExecutionSource',
  'JobExecutionStatus',
  'LOCALE_COOKIE_NAME',
  'LeaseLostError',
  'MAX_DATA_PLANE_POOL_SIZE',
  'PlumbusError',
  'PolicyProfile',
  'PromptRegistry',
  'ProviderJsonSchemaError',
  'RelationType',
  'RuleStatus',
  'RuntimeRole',
  'StepStatus',
  'TranslationRegistry',
  'UnauthorizedError',
  'UnknownTenantError',
  'UsageAPIError',
  'aiRules',
  'allKnownModels',
  'apiRules',
  'applyMigrations',
  'applyOverrides',
  'architectureRules',
  'assertFlowLeaseColumns',
  'assertInsidePlumbusProject',
  'assertSafeIdentifier',
  'assertTransition',
  'auditRecords',
  'authenticationFailureToHttp',
  'buildAISecurityConfig',
  'buildAuthenticationRequest',
  'buildCapabilityRuntimeDeps',
  'buildHistoryEntry',
  'buildStepDeps',
  'buildWorkerAiService',
  'builtInProfiles',
  'calculateModelCost',
  'capabilityDependencyRules',
  'capabilityTemplate',
  'capabilityTestTemplate',
  'checkAppStructure',
  'checkConfig',
  'checkLegacyArtifacts',
  'checkNodeVersion',
  'checkPackageJson',
  'checkPlumbusCore',
  'checkPlumbusUi',
  'checkPostgreSQL',
  'checkPromptSecurity',
  'checkRedis',
  'checkTypeScript',
  'chunkDocument',
  'collectMaskedFieldsFromEntities',
  'collectSchemas',
  'commandRequiresProject',
  'computeNextRun',
  'computeRetryDelay',
  'computeStatus',
  'createAIService',
  'createAnthropicAdapter',
  'createAuditService',
  'createChildSpan',
  'createCli',
  'createCompositeRequestAuthenticator',
  'createCostTracker',
  'createDatabaseAuditWriter',
  'createDeferredJobDispatchService',
  'createErrorService',
  'createEventEmitter',
  'createEventWorker',
  'createExplainabilityTracker',
  'createExplanationTracker',
  'createFlowEngine',
  'createFlowScheduler',
  'createFlowService',
  'createFlowTriggerHandler',
  'createGovernanceRuleEngine',
  'createIdempotencyService',
  'createInMemoryQueue',
  'createInMemoryVectorStore',
  'createJobDispatchService',
  'createJobService',
  'createJwtAdapter',
  'createMetricsRegistry',
  'createOidcAdapter',
  'createOpenAIAdapter',
  'createOutboxDispatcher',
  'createOverrideStore',
  'createPlumbusMetrics',
  'createPooledDataPlaneResolver',
  'createProviderAdapter',
  'createRAGPipeline',
  'createRedisQueue',
  'createRepository',
  'createSamlAdapter',
  'createScimService',
  'createServer',
  'createSingleDataPlaneResolver',
  'createStructuredLogger',
  'createTraceContext',
  'createTracer',
  'createTranslationResolver',
  'createTranslationService',
  'createUsageAPIClient',
  'createWorkerPool',
  'deadLetterFlow',
  'deadLetterTable',
  'decryptFieldValue',
  'defineCapability',
  'defineEntity',
  'defineEvent',
  'defineFlow',
  'definePrompt',
  'defineTranslation',
  'deriveLedgerUsage',
  'discoverRuntimeResources',
  'dispatchQueuedJob',
  'documentChunksTable',
  'documentsTable',
  'dropDataPlane',
  'encryptFieldValue',
  'entityTemplate',
  'errorToHttpResponse',
  'errorToHttpStatus',
  'evaluateAccess',
  'evaluatePolicy',
  'evaluatePolicyProfile',
  'eventTemplate',
  'executeCapability',
  'executeStep',
  'extractTraceFromHeaders',
  'field',
  'findModelRate',
  'findPlumbusProjectRoot',
  'flowDeadLetterTable',
  'flowExecutionsTable',
  'flowSchedulesTable',
  'flowTemplate',
  'formatPolicyReport',
  'formatTraceparent',
  'formatTranslationStatus',
  'generateAgentsMd',
  'generateAll',
  'generateAllPolicyReports',
  'generateCapabilityBrief',
  'generateCapabilityNameType',
  'generateCapabilityTypes',
  'generateClaudeMd',
  'generateClientFunction',
  'generateCopilotInstructions',
  'generateCursorCapabilityRule',
  'generateCursorRule',
  'generateDataServiceMap',
  'generateDrizzleSchema',
  'generateEntityBrief',
  'generateEntityInterface',
  'generateEntityTypeFile',
  'generateManifestEntry',
  'generateOpenApiPath',
  'generatePolicyReport',
  'generateProjectBrief',
  'generateProjectBriefFromResources',
  'generateProjectStructure',
  'generateReactHook',
  'generateSchemas',
  'generateSpanId',
  'generateTraceId',
  'generateWithValidation',
  'generateWorkerId',
  'getCanonicalCapabilityName',
  'getEncryptedFields',
  'getMaskedFields',
  'govRuleCapabilityMissingAccessPolicy',
  'govRuleEntityTenantIsolation',
  'gte',
  'hashPassword',
  'idempotencyTable',
  'ilike',
  'injectTraceHeaders',
  'isApiExposed',
  'isCanonicalCapabilityName',
  'isEncryptedValue',
  'isPlumbusError',
  'isTerminal',
  'isValidTransition',
  'jobEventType',
  'jobExecutionsTable',
  'joinAndFilterModels',
  'like',
  'loadConfig',
  'lte',
  'mcpRules',
  'needsWorkerPool',
  'normalizeFinishReason',
  'openDataPlaneConnection',
  'outboxTable',
  'parseCookieHeader',
  'parseDurationToMs',
  'parseTraceparent',
  'privacyRules',
  'promptTemplate',
  'provisionDataPlane',
  'quoteIdentifier',
  'registerAllRoutes',
  'registerCapabilityConsumers',
  'registerCapabilityRoute',
  'registerJobStatusRoute',
  'registerStreamingRoute',
  'resolveEncryptionKey',
  'resolveRequestLocale',
  'resolveRuntimeQueues',
  'resolveRuntimeRole',
  'rollbackLastMigration',
  'ruleAIWithoutExplanation',
  'ruleApiDeprecatedWithoutReplacement',
  'ruleApiMetadataWithoutExposure',
  'ruleApiMissingAuth',
  'ruleApiMissingOperationId',
  'ruleApiPublicMutationWithoutIdempotency',
  'ruleCapabilityAccessPolicy',
  'ruleCapabilityEffects',
  'ruleCrossTenantDataAccess',
  'ruleEncryptedSensitiveFields',
  'ruleEntityFieldClassification',
  'ruleEntityMissingDescription',
  'ruleEntityTenantIsolation',
  'ruleExcessiveAIUsage',
  'ruleExcessiveDataRetention',
  'ruleExcessiveEffects',
  'ruleExcessiveFlowBranching',
  'ruleExcessiveFlowSteps',
  'ruleMissingAuditConfig',
  'ruleMissingFieldClassification',
  'ruleOverlyPermissiveRoles',
  'rulePersonalDataInLogs',
  'ruleSensitiveFieldUnencrypted',
  'runDev',
  'runDoctorChecks',
  'runFullDoctorChecks',
  'runGovernanceRules',
  'runToolLoop',
  'safeJsonStringify',
  'securityRules',
  'shouldStartApiServer',
  'shouldStartWorkerPool',
  'shouldUseRedisBackend',
  'signJwt',
  'singleProviderConfig',
  'sql',
  'startDevServer',
  'sweepFailedFlows',
  'toCamelCase',
  'toKebabCase',
  'toPascalCase',
  'translationTemplate',
  'tryCreateRedisClient',
  'validateConfig',
  'verifyPassword',
  'withLogMasking',
  'workerRules',
  'wrapAuthAdapter',
  'writeAgentFiles',
  'zodInputToJsonSchema',
  'zodToProviderJsonSchema',
  'zodTypeToString',
];

/** Names reachable only through the `./runtime` seam, never from `.` or `./testing`. */
const SEAM_ONLY: readonly string[] = ['createExecutionContext'];

/**
 * The `./runtime` seam's exact value surface. It is framework-internal and
 * carries no compatibility guarantee, but it is still a published subpath, so
 * every name on it is added deliberately rather than by a stray re-export.
 */
const RUNTIME_SEAM_EXPORTS: readonly string[] = ['createExecutionContext'];

/** Subpaths the package publishes. A new one widens the framework's surface. */
const PUBLISHED_ENTRY_POINTS: readonly string[] = [
  '.',
  './errors',
  './runtime',
  './testing',
  './zod',
  './vitest',
  './mcp',
];

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readPackageManifest(): { exports: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
}

describe('@plumbus/core export surface', () => {
  it('root entry point exports exactly the recorded list', () => {
    expect(Object.keys(core).sort()).toEqual([...PUBLIC_EXPORTS]);
  });

  it('the recorded list is sorted and free of duplicates', () => {
    expect([...PUBLIC_EXPORTS]).toEqual([...new Set(PUBLIC_EXPORTS)].sort());
  });

  it('does not publish the execution-context factory from the root entry point', () => {
    for (const name of SEAM_ONLY) {
      expect(Object.keys(core)).not.toContain(name);
      expect(PUBLIC_EXPORTS).not.toContain(name);
    }
  });

  it('does not publish the execution-context factory from the testing entry point', () => {
    for (const name of SEAM_ONLY) {
      expect(Object.keys(testing)).not.toContain(name);
    }
    // The sanctioned way to obtain a context in tests stays available.
    expect(typeof testing.createTestContext).toBe('function');
  });

  it('publishes the execution-context factory from the runtime seam', () => {
    // Runtime hosts — the transport packages and an application's own server
    // bootstrap — keep a supported way to build a context. Naming the seam is
    // the deliberate act that the root barrel no longer permits by accident.
    expect(Object.keys(runtimeSeam).sort()).toEqual([...RUNTIME_SEAM_EXPORTS].sort());
    expect(typeof runtimeSeam.createExecutionContext).toBe('function');
  });

  it('publishes only the recorded entry points, with no deep-import wildcard', () => {
    const { exports } = readPackageManifest();
    expect(Object.keys(exports).sort()).toEqual([...PUBLISHED_ENTRY_POINTS].sort());
    for (const subpath of Object.keys(exports)) {
      expect(subpath).not.toContain('*');
    }
    // No entry point resolves into the execution module itself. The factory is
    // reachable only through the curated `./runtime` seam file, so the rest of
    // that module stays unreachable from outside the package.
    expect(JSON.stringify(exports)).not.toContain('execution');
  });
});
