// ── Testing Module ──
// Test utilities for Plumbus applications: mock context factory, capability runner,
// flow simulator, security assertion helpers, governance test helpers, and scaffolding.
// Use createTestContext() for a fully-mocked ExecutionContext.
//
// Key exports: createTestContext, runCapability, simulateFlow, assertAccessDenied

// ── Context & Mock Factories ──
export {
  createInMemoryRepository,
  createTestAuth,
  createTestContext,
  createTestData,
  fixedTime,
  mockAI,
  mockAudit,
  mockEvents,
  mockFlows,
  mockLogger,
} from './context.js';
export type {
  AIResponse,
  MockAuditService,
  MockEventService,
  MockFlowService,
  MockLoggerService,
  TestAuthOptions,
  TestContextOptions,
} from './context.js';

// ── Capability Test Runner ──
export { runCapability } from './run-capability.js';
export type { RunCapabilityOptions } from './run-capability.js';

// ── Flow Simulator ──
export { simulateFlow } from './simulate-flow.js';
export type {
  FlowSimulationResult,
  SimulateFlowOptions,
} from './simulate-flow.js';

// ── Security Test Helpers ──
export {
  adminAuth,
  assertAccessAllowed,
  assertAccessDenied,
  assertCapabilityAllowed,
  assertCapabilityDenied,
  assertPlumbusError,
  assertTenantIsolation,
  assertValidationError,
  serviceAccountAuth,
  unauthenticated,
} from './security.js';

// ── Governance Test Helpers ──
export {
  assertGovernanceSignals,
  assertMaxSeverity,
  assertNoGovernanceSignal,
  assertOverridesApplied,
  assertPolicyCompliance,
  assertPolicyNonCompliance,
  emptyInventory,
  evaluateGovernance,
} from './governance.js';

// ── Test Scaffolding Generator ──
export {
  generateCapabilityTest,
  generateFlowTest,
  generateGovernanceTest,
  generateSecurityTest,
} from './scaffolding.js';

// ── E2E / Browser Test Utilities ──
export { createE2EServer, createTestBearerHeader } from './e2e.js';
export type { E2EServerContext, E2EServerOptions } from './e2e.js';
