import { describe, expect, it } from 'vitest';
import { createExplanationTracker } from '../tracker.js';

describe('ExplanationTracker', () => {
  describe('recordAuthorization', () => {
    it('records allow decisions', () => {
      const tracker = createExplanationTracker();
      const record = tracker.recordAuthorization({
        capability: 'getUser',
        actor: 'user-1',
        tenantId: 't-1',
        decision: 'allow',
        matchedRoles: ['admin'],
        matchedScopes: ['read:users'],
      });
      expect(record.id).toBeDefined();
      expect(record.type).toBe('authorization');
      expect(record.component).toBe('capability:getUser');
      expect(record.decision).toBe('allow');
      expect(record.reasoning).toContain('admin');
    });

    it('records deny decisions with reason', () => {
      const tracker = createExplanationTracker();
      const record = tracker.recordAuthorization({
        capability: 'deleteUser',
        actor: 'user-2',
        decision: 'deny',
        deniedReason: 'insufficient roles',
      });
      expect(record.decision).toBe('deny');
      expect(record.reasoning).toContain('insufficient roles');
    });
  });

  describe('recordFlowBranch', () => {
    it('records branch decisions', () => {
      const tracker = createExplanationTracker();
      const record = tracker.recordFlowBranch({
        flowName: 'refund-approval',
        executionId: 'exec-1',
        stepName: 'check-amount',
        condition: 'amount > 1000',
        evaluatedTo: true,
        branchTaken: 'manual-review',
        stateSnapshot: { amount: 1500 },
      });
      expect(record.type).toBe('flow-branch');
      expect(record.component).toBe('flow:refund-approval');
      expect(record.decision).toBe('branch:manual-review');
      expect(record.reasoning).toContain('amount > 1000');
      expect(record.reasoning).toContain('true');
    });
  });

  describe('recordAIInvocation', () => {
    it('records AI invocations', () => {
      const tracker = createExplanationTracker();
      const record = tracker.recordAIInvocation({
        promptName: 'classify-ticket',
        operation: 'classify',
        model: 'gpt-4',
        retrievalSources: [{ source: 'doc1.md', score: 0.95 }],
        validationResult: { passed: true, attempts: 1 },
        tokenUsage: { input: 500, output: 50 },
      });
      expect(record.type).toBe('ai-invocation');
      expect(record.component).toBe('prompt:classify-ticket');
      expect(record.reasoning).toContain('gpt-4');
      expect(record.reasoning).toContain('1 retrieval sources');
      expect(record.outcome).toBe('validated');
    });

    it('records unvalidated AI invocations', () => {
      const tracker = createExplanationTracker();
      const record = tracker.recordAIInvocation({
        operation: 'generate',
        validationResult: { passed: false, attempts: 3 },
      });
      expect(record.component).toBe('ai:generate');
      expect(record.outcome).toBe('unvalidated');
    });
  });

  describe('recordGovernance', () => {
    it('records active governance signals', () => {
      const tracker = createExplanationTracker();
      const record = tracker.recordGovernance({
        rule: 'privacy.sensitive-field-unencrypted',
        severity: 'high',
        affectedComponent: 'entity:User.ssn',
        overridden: false,
      });
      expect(record.type).toBe('governance');
      expect(record.outcome).toBe('active');
      expect(record.reasoning).toContain('high');
    });

    it('records overridden governance signals', () => {
      const tracker = createExplanationTracker();
      const record = tracker.recordGovernance({
        rule: 'security.no-tenant-isolation',
        severity: 'info',
        affectedComponent: 'entity:Config',
        overridden: true,
        overrideJustification: 'Global config entity — not tenant-specific',
      });
      expect(record.outcome).toBe('overridden');
      expect(record.reasoning).toContain('Global config entity');
    });
  });

  describe('querying', () => {
    it('returns all records', () => {
      const tracker = createExplanationTracker();
      tracker.recordAuthorization({ capability: 'a', actor: 'u1', decision: 'allow' });
      tracker.recordFlowBranch({
        flowName: 'f',
        executionId: 'e',
        stepName: 's',
        condition: 'x',
        evaluatedTo: true,
        branchTaken: 'y',
      });
      expect(tracker.getRecords()).toHaveLength(2);
    });

    it('filters by type', () => {
      const tracker = createExplanationTracker();
      tracker.recordAuthorization({ capability: 'a', actor: 'u1', decision: 'allow' });
      tracker.recordFlowBranch({
        flowName: 'f',
        executionId: 'e',
        stepName: 's',
        condition: 'x',
        evaluatedTo: true,
        branchTaken: 'y',
      });
      expect(tracker.getByType('authorization')).toHaveLength(1);
      expect(tracker.getByType('flow-branch')).toHaveLength(1);
    });

    it('filters by component', () => {
      const tracker = createExplanationTracker();
      tracker.recordAuthorization({ capability: 'getUser', actor: 'u1', decision: 'allow' });
      tracker.recordAuthorization({ capability: 'deleteUser', actor: 'u1', decision: 'deny' });
      expect(tracker.getByComponent('capability:getUser')).toHaveLength(1);
    });

    it('filters by time range', () => {
      const tracker = createExplanationTracker();
      tracker.recordAuthorization({ capability: 'a', actor: 'u1', decision: 'allow' });
      const future = new Date(Date.now() + 86_400_000);
      expect(tracker.getRecords({ since: future })).toHaveLength(0);
    });

    it('filters by actor when configured', () => {
      const tracker = createExplanationTracker({ actor: 'test-user' });
      tracker.recordAuthorization({ capability: 'a', actor: 'u1', decision: 'allow' });
      expect(tracker.getRecords({ actor: 'test-user' })).toHaveLength(1);
      expect(tracker.getRecords({ actor: 'other' })).toHaveLength(0);
    });
  });

  describe('audit integration', () => {
    it('records to audit service when configured', async () => {
      const auditLog: Array<{ eventType: string; metadata: unknown }> = [];
      const tracker = createExplanationTracker({
        audit: {
          record: async (eventType, metadata) => {
            auditLog.push({ eventType, metadata });
          },
        },
      });
      tracker.recordAuthorization({ capability: 'test', actor: 'u1', decision: 'allow' });
      // Audit is called synchronously (fire-and-forget)
      expect(auditLog).toHaveLength(1);
      expect(auditLog[0]!.eventType).toBe('explanation.authorization');
    });
  });
});
