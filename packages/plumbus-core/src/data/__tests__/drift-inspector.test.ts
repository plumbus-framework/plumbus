import { describe, expect, it } from 'vitest';
import {
  type DriftReport,
  extractCreateTableNames,
  FRAMEWORK_TABLE_NAMES,
  formatDriftReport,
} from '../drift-inspector.js';

describe('FRAMEWORK_TABLE_NAMES', () => {
  it('contains all 19 framework table names', () => {
    expect(FRAMEWORK_TABLE_NAMES).toHaveLength(19);
  });

  it('includes expected table names', () => {
    expect(FRAMEWORK_TABLE_NAMES).toContain('audit_records');
    expect(FRAMEWORK_TABLE_NAMES).toContain('job_executions');
    expect(FRAMEWORK_TABLE_NAMES).toContain('event_outbox');
    expect(FRAMEWORK_TABLE_NAMES).toContain('event_idempotency');
    expect(FRAMEWORK_TABLE_NAMES).toContain('event_dead_letter');
    expect(FRAMEWORK_TABLE_NAMES).toContain('flow_executions');
    expect(FRAMEWORK_TABLE_NAMES).toContain('flow_dead_letter');
    expect(FRAMEWORK_TABLE_NAMES).toContain('flow_schedules');
    expect(FRAMEWORK_TABLE_NAMES).toContain('documents');
    expect(FRAMEWORK_TABLE_NAMES).toContain('document_chunks');
    expect(FRAMEWORK_TABLE_NAMES).toContain('execution_state');
    expect(FRAMEWORK_TABLE_NAMES).toContain('step_execution');
    expect(FRAMEWORK_TABLE_NAMES).toContain('wait_state');
    expect(FRAMEWORK_TABLE_NAMES).toContain('terminal_state');
    expect(FRAMEWORK_TABLE_NAMES).toContain('dispatch_outbox');
    expect(FRAMEWORK_TABLE_NAMES).toContain('side_effect_log');
    expect(FRAMEWORK_TABLE_NAMES).toContain('human_task');
    expect(FRAMEWORK_TABLE_NAMES).toContain('approval_request');
    expect(FRAMEWORK_TABLE_NAMES).toContain('approval_decision');
  });
});

describe('extractCreateTableNames', () => {
  it('extracts quoted table names', () => {
    const sql = 'CREATE TABLE "event_outbox" ("id" uuid PRIMARY KEY);';
    expect(extractCreateTableNames(sql)).toEqual(['event_outbox']);
  });

  it('extracts schema-qualified table names', () => {
    const sql = 'CREATE TABLE "core_plumbus"."execution_state" ("execution_id" text PRIMARY KEY);';
    expect(extractCreateTableNames(sql)).toEqual(['execution_state']);
  });

  it('extracts unquoted table names', () => {
    const sql = 'CREATE TABLE flow_executions (id uuid PRIMARY KEY);';
    expect(extractCreateTableNames(sql)).toEqual(['flow_executions']);
  });

  it('extracts multiple CREATE TABLE statements', () => {
    const sql = [
      'CREATE TABLE "event_outbox" ("id" uuid PRIMARY KEY);',
      '--> statement-breakpoint',
      'CREATE TABLE "flow_executions" ("id" uuid PRIMARY KEY);',
    ].join('\n');
    expect(extractCreateTableNames(sql)).toEqual(['event_outbox', 'flow_executions']);
  });

  it('handles IF NOT EXISTS syntax', () => {
    const sql = 'CREATE TABLE IF NOT EXISTS "audit_records" ("id" uuid PRIMARY KEY);';
    expect(extractCreateTableNames(sql)).toEqual(['audit_records']);
  });

  it('returns empty for SQL without CREATE TABLE', () => {
    const sql = 'ALTER TABLE "event_outbox" ADD COLUMN "new_col" text;';
    expect(extractCreateTableNames(sql)).toEqual([]);
  });

  it('handles mixed case CREATE TABLE keywords', () => {
    const sql = 'create table "documents" ("id" varchar PRIMARY KEY);';
    expect(extractCreateTableNames(sql)).toEqual(['documents']);
  });

  it('handles extra whitespace in CREATE TABLE', () => {
    const sql = 'CREATE   TABLE   "event_outbox"  ("id" uuid);';
    expect(extractCreateTableNames(sql)).toEqual(['event_outbox']);
  });
});

describe('formatDriftReport', () => {
  it('lists pre-existing framework tables', () => {
    const report: DriftReport = {
      hasDrift: false,
      existingFrameworkTables: ['event_outbox', 'flow_executions'],
      missingFrameworkTables: [],
      tables: [
        { tableName: 'event_outbox', exists: true, columnDrifts: [] },
        { tableName: 'flow_executions', exists: true, columnDrifts: [] },
      ],
    };
    const lines = formatDriftReport(report);
    expect(lines[0]).toContain('event_outbox');
    expect(lines[0]).toContain('flow_executions');
  });

  it('reports missing columns', () => {
    const report: DriftReport = {
      hasDrift: true,
      existingFrameworkTables: ['event_outbox'],
      missingFrameworkTables: [],
      tables: [
        {
          tableName: 'event_outbox',
          exists: true,
          columnDrifts: [{ column: 'correlation_id', kind: 'missing_in_db', expected: 'text' }],
        },
      ],
    };
    const output = formatDriftReport(report).join('\n');
    expect(output).toContain('correlation_id');
    expect(output).toContain('missing');
  });

  it('reports type mismatches', () => {
    const report: DriftReport = {
      hasDrift: true,
      existingFrameworkTables: ['event_outbox'],
      missingFrameworkTables: [],
      tables: [
        {
          tableName: 'event_outbox',
          exists: true,
          columnDrifts: [
            {
              column: 'retry_count',
              kind: 'type_mismatch',
              expected: 'text',
              actual: 'integer',
            },
          ],
        },
      ],
    };
    const output = formatDriftReport(report).join('\n');
    expect(output).toContain('retry_count');
    expect(output).toContain('type mismatch');
    expect(output).toContain('text');
    expect(output).toContain('integer');
  });

  it('reports extra columns in DB', () => {
    const report: DriftReport = {
      hasDrift: true,
      existingFrameworkTables: ['event_outbox'],
      missingFrameworkTables: [],
      tables: [
        {
          tableName: 'event_outbox',
          exists: true,
          columnDrifts: [{ column: 'extra_col', kind: 'extra_in_db', actual: 'text' }],
        },
      ],
    };
    const output = formatDriftReport(report).join('\n');
    expect(output).toContain('extra_col');
    expect(output).toContain('exists in DB but not in schema');
  });

  it('includes recovery instructions', () => {
    const report: DriftReport = {
      hasDrift: true,
      existingFrameworkTables: ['event_outbox'],
      missingFrameworkTables: [],
      tables: [
        {
          tableName: 'event_outbox',
          exists: true,
          columnDrifts: [{ column: 'x', kind: 'missing_in_db', expected: 'text' }],
        },
      ],
    };
    const output = formatDriftReport(report).join('\n');
    expect(output).toContain('Recovery');
    expect(output).toContain('plumbus migrate reconcile');
  });

  it('reports nullability mismatch', () => {
    const report: DriftReport = {
      hasDrift: true,
      existingFrameworkTables: ['flow_executions'],
      missingFrameworkTables: [],
      tables: [
        {
          tableName: 'flow_executions',
          exists: true,
          columnDrifts: [
            {
              column: 'status',
              kind: 'nullability_mismatch',
              expected: 'not null',
              actual: 'nullable',
            },
          ],
        },
      ],
    };
    const output = formatDriftReport(report).join('\n');
    expect(output).toContain('status');
    expect(output).toContain('nullability');
  });
});
