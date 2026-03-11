import { describe, expect, it } from 'vitest';
import {
  generateCapabilityTest,
  generateFlowTest,
  generateGovernanceTest,
  generateSecurityTest,
} from '../scaffolding.js';

describe('generateCapabilityTest', () => {
  it('generates valid test file content', () => {
    const output = generateCapabilityTest('create-order', 'orders');
    expect(output).toContain('import { describe, it, expect }');
    expect(output).toContain('from "vitest"');
    expect(output).toContain('from "plumbus-core/testing"');
    expect(output).toContain('runCapability');
    expect(output).toContain('createOrder');
    expect(output).toContain('CreateOrder');
  });

  it('includes success, validation, and auth test cases', () => {
    const output = generateCapabilityTest('list-users', 'users');
    expect(output).toContain('executes successfully with valid input');
    expect(output).toContain('rejects invalid input');
    expect(output).toContain('denies access to unauthorized users');
    expect(output).toContain('allows access for authorized roles');
  });

  it('imports the capability by camelCase name', () => {
    const output = generateCapabilityTest('get-user-profile', 'users');
    expect(output).toContain('getUserProfile');
  });
});

describe('generateFlowTest', () => {
  it('generates valid flow test content', () => {
    const output = generateFlowTest('order-processing', 'orders');
    expect(output).toContain('simulateFlow');
    expect(output).toContain('orderProcessingFlow');
    expect(output).toContain('OrderProcessing Flow');
  });

  it('includes completion and failure test cases', () => {
    const output = generateFlowTest('payment-flow', 'payments');
    expect(output).toContain('completes all steps successfully');
    expect(output).toContain('tracks step execution history');
    expect(output).toContain('handles capability step failure');
  });
});

describe('generateSecurityTest', () => {
  it('generates valid security test content', () => {
    const output = generateSecurityTest('update-profile', 'users');
    expect(output).toContain('assertCapabilityDenied');
    expect(output).toContain('assertCapabilityAllowed');
    expect(output).toContain('assertTenantIsolation');
    expect(output).toContain('UpdateProfile Security');
    expect(output).toContain('updateProfile');
  });

  it('includes tenant isolation and auth test cases', () => {
    const output = generateSecurityTest('delete-record', 'records');
    expect(output).toContain('denies unauthenticated access');
    expect(output).toContain('allows admin access');
    expect(output).toContain('enforces tenant isolation');
  });
});

describe('generateGovernanceTest', () => {
  it('generates valid governance test content', () => {
    const output = generateGovernanceTest('orders');
    expect(output).toContain('evaluateGovernance');
    expect(output).toContain('emptyInventory');
    expect(output).toContain('assertPolicyCompliance');
    expect(output).toContain('Orders Governance');
  });

  it('includes security, privacy, and policy test cases', () => {
    const output = generateGovernanceTest('payments');
    expect(output).toContain('passes security rules');
    expect(output).toContain('passes privacy rules');
    expect(output).toContain('complies with internal security baseline');
  });
});
