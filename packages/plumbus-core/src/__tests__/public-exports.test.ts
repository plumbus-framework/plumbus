import { describe, expect, it } from 'vitest';
import {
  assertFlowLeaseColumns,
  capabilityDependencyRules,
  mcpRules,
  workerRules,
} from '../index.js';

describe('public exports (A5)', () => {
  it('exports governance rule bundles', () => {
    expect(Array.isArray(mcpRules)).toBe(true);
    expect(mcpRules.length).toBeGreaterThan(0);
    expect(Array.isArray(workerRules)).toBe(true);
    expect(workerRules.length).toBeGreaterThan(0);
    expect(Array.isArray(capabilityDependencyRules)).toBe(true);
    expect(capabilityDependencyRules.length).toBeGreaterThan(0);
  });

  it('exports assertFlowLeaseColumns', () => {
    expect(typeof assertFlowLeaseColumns).toBe('function');
  });
});
