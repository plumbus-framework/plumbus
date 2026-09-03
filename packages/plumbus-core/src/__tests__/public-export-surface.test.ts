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
  'AIValidationError',
  'APPROVAL_PENDING_WAIT',
  'ActionRiskTier',
  'BackoffStrategy',
  'BudgetExhaustedError',
  'COMPILED_FLOW_CONTRACT_VERSION',
  'CREDENTIAL_REDACTED',
  'CapabilityKind',
  'CapabilityRegistry',
  'CompiledFlowRegistry',
  'ConsumerRegistry',
  'CredentialCatalogError',
  'DATA_PLANE_MIGRATE_APPLICATION_NAME',
  'DEFAULT_COMPILED_FLOWS_DIRECTORY',
  'DEFAULT_CORE_SCHEMA',
  'DEFAULT_DATA_PLANE_CACHE_SIZE',
  'DEFAULT_DATA_PLANE_POOL_SIZE',
  'DEFAULT_GOVERNED_ARTIFACTS_DIRECTORY',
  'DEFAULT_PACKAGE_SCHEMA_PREFIX',
  'DEFAULT_SCHEDULE_CATCH_UP_MAX',
  'DEFINITION_STRATEGY_NOT_SUPPORTED',
  'DataForbiddenError',
  'DataInternalError',
  'DataPlaneConnectionError',
  'DataPlaneGuardError',
  'DataPlaneNameError',
  'DataPlaneProvisioningError',
  'DataValidationError',
  'DefinitionInFlightStrategy',
  'DefinitionStrategyNotSupportedError',
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
  'GovernedAiBlockedError',
  'GovernedArtifactConflictError',
  'JSON_SCHEMA_2020_12_DIALECT',
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
  'ReviewMandateReason',
  'RuleStatus',
  'RuntimeRole',
  'ScheduleCatchUpPolicy',
  'StepStatus',
  'TranslationRegistry',
  'UnauthorizedError',
  'UnknownTenantError',
  'UsageAPIError',
  'aiRules',
  'allKnownModels',
  'apiRules',
  'applyDataPlaneMigrations',
  'applyMigrations',
  'applyOverrides',
  'architectureRules',
  'assertFlowLeaseColumns',
  'assertInsidePlumbusProject',
  'assertSafeIdentifier',
  'assertSupportedDefinitionStrategy',
  'assertTransition',
  'auditRecords',
  'authenticationFailureToHttp',
  'buildAISecurityConfig',
  'buildAuthenticationRequest',
  'buildCapabilityRuntimeDeps',
  'buildGenerateOpenApiDocument',
  'buildHistoryEntry',
  'buildStepDeps',
  'buildWorkerAiService',
  'builtInProfiles',
  'calculateModelCost',
  'capabilityDependencyRules',
  'capabilityHttpMethod',
  'capabilityTemplate',
  'capabilityTestTemplate',
  'chargeExecutionBudget',
  'checkAppStructure',
  'checkConfig',
  'checkGovernedBudget',
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
  'compileFlowDefinition',
  'computeNextRun',
  'computeRetryDelay',
  'computeStatus',
  'createAIService',
  'createAnthropicAdapter',
  'createApprovalService',
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
  'createExecutionBudgetLedger',
  'createExplainabilityTracker',
  'createExplanationTracker',
  'createFilesystemGovernedArtifactStore',
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
  'createMemoryApprovalStore',
  'createMemoryCredentialCatalog',
  'createMemoryGovernedArtifactStore',
  'createMetricsRegistry',
  'createOidcAdapter',
  'createOpenAIAdapter',
  'createOutboxDispatcher',
  'createOverrideStore',
  'createPlumbusMetrics',
  'createPlumbusRuntime',
  'createPooledDataPlaneResolver',
  'createPromptRegistry',
  'createProviderAdapter',
  'createRAGPipeline',
  'createRedisQueue',
  'createRepository',
  'createSamlAdapter',
  'createScimService',
  'createServer',
  'createSingleDataPlaneResolver',
  'createSqlApprovalStore',
  'createStructuredLogger',
  'createTraceContext',
  'createTracer',
  'createTranslationResolver',
  'createTranslationService',
  'createUsageAPIClient',
  'createWorkerPool',
  'deadLetterFlow',
  'deadLetterTable',
  'decryptBytes',
  'decryptFieldValue',
  'defineCapability',
  'defineEntity',
  'defineEvent',
  'defineFlow',
  'definePrompt',
  'defineTranslation',
  'deriveLedgerUsage',
  'digestGovernedArtifact',
  'discoverRuntimeResources',
  'dispatchQueuedJob',
  'documentChunksTable',
  'documentsTable',
  'dropDataPlane',
  'encryptBytes',
  'encryptFieldValue',
  'entityTemplate',
  'errorToHttpResponse',
  'errorToHttpStatus',
  'evaluateAccess',
  'evaluateEventSubscriptionDelivery',
  'evaluatePolicy',
  'evaluatePolicyProfile',
  'eventTemplate',
  'executeCapability',
  'executeStep',
  'extractTraceFromHeaders',
  'field',
  'fillPromptTemplate',
  'findModelRate',
  'findPlumbusProjectRoot',
  'flowDeadLetterTable',
  'flowDefinitionId',
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
  'governedReviewSubject',
  'gte',
  'hashPassword',
  'hydrateCompiledFlow',
  'idempotencyTable',
  'ilike',
  'injectTraceHeaders',
  'invokeGovernedAi',
  'isActionRiskTier',
  'isApiExposed',
  'isCanonicalCapabilityName',
  'isEncryptedValue',
  'isPlumbusError',
  'isProhibitedRiskTier',
  'isTerminal',
  'isValidTransition',
  'jobEventType',
  'jobExecutionsTable',
  'joinAndFilterModels',
  'like',
  'loadCompiledFlowRegistryFromDirectory',
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
  'planMissedSchedule',
  'privacyRules',
  'promptTemplate',
  'provisionDataPlane',
  'quoteIdentifier',
  'registerAllRoutes',
  'registerCapabilityConsumers',
  'registerCapabilityRoute',
  'registerJobStatusRoute',
  'registerStreamingRoute',
  'requiresApprovalForRiskTier',
  'resolveEncryptionKey',
  'resolveGovernedArtifactStore',
  'resolveRequestLocale',
  'resolveRuntimeQueues',
  'resolveRuntimeRole',
  'retryDeadLetteredFlow',
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
  'scanForbiddenPaths',
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
  'toJsonSchema2020',
  'toKebabCase',
  'toOpenApi31Document',
  'toPascalCase',
  'translationTemplate',
  'tryCreateRedisClient',
  'tryLoadCompiledFlowRegistryFromDirectory',
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
  './credentials',
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
