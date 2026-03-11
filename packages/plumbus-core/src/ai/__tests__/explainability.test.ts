import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../types/audit.js';
import { createExplainabilityTracker } from '../explainability.js';

describe('AI Explainability Tracker', () => {
  it('records an invocation and assigns id/timestamp', () => {
    const tracker = createExplainabilityTracker();
    const record = tracker.record({
      operation: 'generate',
      promptName: 'summarize',
      model: 'gpt-4o',
      input: { text: 'hello' },
      output: { summary: 'hi' },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      latencyMs: 200,
    });

    expect(record.id).toBeDefined();
    expect(record.timestamp).toBeInstanceOf(Date);
    expect(record.promptName).toBe('summarize');
    expect(record.operation).toBe('generate');
  });

  it('retrieves all records', () => {
    const tracker = createExplainabilityTracker();
    tracker.record({ operation: 'generate', input: {}, output: null, latencyMs: 100 });
    tracker.record({ operation: 'extract', input: {}, output: null, latencyMs: 200 });

    expect(tracker.getRecords()).toHaveLength(2);
  });

  it('filters by prompt name', () => {
    const tracker = createExplainabilityTracker();
    tracker.record({
      operation: 'generate',
      promptName: 'a',
      input: {},
      output: null,
      latencyMs: 100,
    });
    tracker.record({
      operation: 'generate',
      promptName: 'b',
      input: {},
      output: null,
      latencyMs: 100,
    });
    tracker.record({
      operation: 'generate',
      promptName: 'a',
      input: {},
      output: null,
      latencyMs: 100,
    });

    expect(tracker.getByPrompt('a')).toHaveLength(2);
    expect(tracker.getByPrompt('b')).toHaveLength(1);
  });

  it('links to audit trail when audit service configured', () => {
    const auditRecord = vi.fn();
    const audit: AuditService = { record: auditRecord };

    const tracker = createExplainabilityTracker({ audit, actor: 'user1' });
    tracker.record({
      operation: 'classify',
      input: { text: 'urgent' },
      output: ['priority'],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      validation: { passed: true, attempts: 1 },
      latencyMs: 150,
    });

    expect(auditRecord).toHaveBeenCalledTimes(1);
    expect(auditRecord).toHaveBeenCalledWith(
      'ai.classify',
      expect.objectContaining({
        actor: 'user1',
        outcome: 'success',
      }),
    );
  });

  it('records failure outcome for failed validation', () => {
    const auditRecord = vi.fn();
    const audit: AuditService = { record: auditRecord };

    const tracker = createExplainabilityTracker({ audit });
    tracker.record({
      operation: 'extract',
      input: {},
      output: null,
      validation: { passed: false, attempts: 3, errors: ['schema mismatch'] },
      latencyMs: 500,
    });

    expect(auditRecord).toHaveBeenCalledWith(
      'ai.extract',
      expect.objectContaining({ outcome: 'failure' }),
    );
  });

  it('includes retrieval source count in audit metadata', () => {
    const auditRecord = vi.fn();
    const audit: AuditService = { record: auditRecord };

    const tracker = createExplainabilityTracker({ audit });
    tracker.record({
      operation: 'generate',
      input: {},
      output: 'answer',
      retrievalSources: [
        { content: 'doc1', source: 'file1', score: 0.9 },
        { content: 'doc2', source: 'file2', score: 0.8 },
      ],
      latencyMs: 300,
    });

    expect(auditRecord).toHaveBeenCalledWith(
      'ai.generate',
      expect.objectContaining({ retrievalSourceCount: 2 }),
    );
  });
});
