// ── Testing Module ──
// Test utilities for Plumbus applications: mock context factory, capability runner,
// flow simulator, security assertion helpers, governance test helpers, and scaffolding.
// Use createTestContext() for a fully-mocked ExecutionContext.
//
// Key exports: createTestContext, runCapability, simulateFlow, assertAccessDenied

export type { Browser, BrowserContext, Page } from 'playwright';
// ── Playwright Re-export ──
// Consumer apps get playwright through the framework — no separate install needed.
export { chromium, firefox, webkit } from 'playwright';
// ── Vitest Re-export ──
// Consumer apps get vitest through the framework — no separate install needed.
// Test files: import { describe, it, expect } from "plumbus-core/testing";
export { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
export type {
  AIResponse,
  MockAuditService,
  MockEventService,
  MockFlowService,
  MockLoggerService,
  TestAuthOptions,
  TestContextOptions,
} from './context.js';
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
export type { E2EServerContext, E2EServerOptions } from './e2e.js';
// ── E2E / Browser Test Utilities ──
export { createE2EServer, createTestBearerHeader } from './e2e.js';

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
export type { RunCapabilityOptions } from './run-capability.js';
// ── Capability Test Runner ──
export { runCapability } from './run-capability.js';
export type {
  E2EActionDescriptor,
  E2EPageDescriptor,
  E2EQueryDescriptor,
} from './scaffolding.js';
// ── Test Scaffolding Generator ──
export {
  generateCapabilityTest,
  generateE2ETest,
  generateFlowTest,
  generateGovernanceTest,
  generateSecurityTest,
} from './scaffolding.js';
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
export type {
  FlowSimulationResult,
  SimulateFlowOptions,
} from './simulate-flow.js';
// ── Flow Simulator ──
export { simulateFlow } from './simulate-flow.js';
