import { describe, expect, it } from 'vitest';
import type { DriftReport } from '../drift-inspector.js';
import {
  formatRewriteSummary,
  rewriteFrameworkDriftMigration,
  rewriteHadEffect,
} from '../framework-migration-rewriter.js';

function makeReport(overrides: Partial<DriftReport>): DriftReport {
  return {
    hasDrift: false,
    existingFrameworkTables: [],
    missingFrameworkTables: [],
    tables: [],
    ...overrides,
  };
}

describe('rewriteFrameworkDriftMigration', () => {
  it('rewrites CREATE TABLE for an existing framework table to ALTER TABLE ADD COLUMN for missing columns only', () => {
    const stmts = [
      `CREATE TABLE "flow_executions" (
\t"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
\t"flow_name" text NOT NULL,
\t"status" text DEFAULT 'created' NOT NULL,
\t"lease_owner" text,
\t"lease_expires_at" timestamp with time zone
);`,
      `CREATE INDEX "flow_exec_lease_idx" ON "flow_executions" USING btree ("status","lease_expires_at");`,
    ];

    const report = makeReport({
      hasDrift: true,
      existingFrameworkTables: ['flow_executions'],
      tables: [
        {
          tableName: 'flow_executions',
          exists: true,
          columnDrifts: [
            { column: 'lease_owner', kind: 'missing_in_db', expected: 'text' },
            {
              column: 'lease_expires_at',
              kind: 'missing_in_db',
              expected: 'timestamp with time zone',
            },
          ],
        },
      ],
    });

    const { statements, summary } = rewriteFrameworkDriftMigration(stmts, report);
    const joined = statements.join('\n');

    expect(joined).not.toMatch(/CREATE\s+TABLE\s+"flow_executions"/i);
    expect(statements).toContain(`ALTER TABLE "flow_executions" ADD COLUMN "lease_owner" text;`);
    expect(statements).toContain(
      `ALTER TABLE "flow_executions" ADD COLUMN "lease_expires_at" timestamp with time zone;`,
    );
    expect(joined).toMatch(/CREATE INDEX IF NOT EXISTS "flow_exec_lease_idx" ON "flow_executions"/);

    expect(summary.alteredTables).toEqual([
      { table: 'flow_executions', addedColumns: ['lease_owner', 'lease_expires_at'] },
    ]);
    expect(summary.droppedCreateTables).toEqual([]);
    expect(summary.wrappedIndexes).toEqual(['flow_exec_lease_idx']);
    expect(summary.warnings).toEqual([]);
    expect(rewriteHadEffect(summary)).toBe(true);
  });

  it('drops CREATE TABLE entirely for an existing framework table with no missing columns', () => {
    const stmts = [
      `CREATE TABLE "event_outbox" (
\t"id" uuid PRIMARY KEY,
\t"event_type" text NOT NULL
);`,
      `CREATE INDEX "event_outbox_status_idx" ON "event_outbox" USING btree ("status");`,
    ];

    const report = makeReport({
      existingFrameworkTables: ['event_outbox'],
      tables: [{ tableName: 'event_outbox', exists: true, columnDrifts: [] }],
    });

    const { statements, summary } = rewriteFrameworkDriftMigration(stmts, report);
    const joined = statements.join('\n');
    expect(joined).not.toMatch(/CREATE\s+TABLE\s+"event_outbox"/i);
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS "event_outbox_status_idx"');
    expect(summary.droppedCreateTables).toEqual(['event_outbox']);
    expect(summary.alteredTables).toEqual([]);
  });

  it('preserves CREATE TABLE for framework tables that do NOT exist in the live DB', () => {
    const stmts = [
      `CREATE TABLE "documents" (
\t"id" varchar(255) PRIMARY KEY NOT NULL,
\t"source" varchar(1024) NOT NULL
);`,
    ];

    const report = makeReport({
      missingFrameworkTables: ['documents'],
      tables: [{ tableName: 'documents', exists: false, columnDrifts: [] }],
    });

    const { statements, summary } = rewriteFrameworkDriftMigration(stmts, report);
    expect(statements.join('\n')).toMatch(/CREATE\s+TABLE\s+"documents"/i);
    expect(summary.droppedCreateTables).toEqual([]);
    expect(summary.alteredTables).toEqual([]);
  });

  it('passes user entity tables through unchanged', () => {
    const stmts = [
      `CREATE TABLE "project" (
\t"id" uuid PRIMARY KEY,
\t"name" text NOT NULL
);`,
    ];

    const { statements, summary } = rewriteFrameworkDriftMigration(stmts, makeReport({}));
    expect(statements).toEqual(stmts);
    expect(rewriteHadEffect(summary)).toBe(false);
  });

  it('wraps CREATE INDEX with IF NOT EXISTS', () => {
    const stmts = [`CREATE INDEX "idx_name" ON "tbl" USING btree ("col");`];
    const { statements, summary } = rewriteFrameworkDriftMigration(stmts, makeReport({}));
    expect(statements[0]).toContain('CREATE INDEX IF NOT EXISTS "idx_name"');
    expect(summary.wrappedIndexes).toEqual(['idx_name']);
  });

  it('wraps CREATE UNIQUE INDEX with IF NOT EXISTS', () => {
    const stmts = [`CREATE UNIQUE INDEX "ux_name" ON "tbl" ("col");`];
    const { statements, summary } = rewriteFrameworkDriftMigration(stmts, makeReport({}));
    expect(statements[0]).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "ux_name"');
    expect(summary.wrappedIndexes).toEqual(['ux_name']);
  });

  it('does not double-wrap CREATE INDEX IF NOT EXISTS', () => {
    const stmts = [`CREATE INDEX IF NOT EXISTS "idx_name" ON "tbl" ("col");`];
    const { statements, summary } = rewriteFrameworkDriftMigration(stmts, makeReport({}));
    expect(statements).toEqual(stmts);
    expect(summary.wrappedIndexes).toEqual([]);
  });

  it('warns when a framework CREATE TABLE contains table-level constraints', () => {
    const stmts = [
      `CREATE TABLE "flow_dead_letter" (
\t"id" uuid PRIMARY KEY,
\t"execution_id" text NOT NULL,
\t"new_col" text,
\tCONSTRAINT "flow_dead_letter_execution_id_unique" UNIQUE("execution_id")
);`,
    ];

    const report = makeReport({
      existingFrameworkTables: ['flow_dead_letter'],
      tables: [
        {
          tableName: 'flow_dead_letter',
          exists: true,
          columnDrifts: [{ column: 'new_col', kind: 'missing_in_db', expected: 'text' }],
        },
      ],
    });

    const { statements, summary } = rewriteFrameworkDriftMigration(stmts, report);
    const joined = statements.join('\n');
    expect(joined).toContain(`ALTER TABLE "flow_dead_letter" ADD COLUMN "new_col" text`);
    expect(joined).not.toContain('CONSTRAINT');
    expect(summary.warnings.some((w) => w.includes('flow_dead_letter'))).toBe(true);
  });

  it('warns and skips when the drift report names a column that the generated CREATE TABLE does not include', () => {
    const stmts = [
      `CREATE TABLE "flow_executions" (
\t"id" uuid PRIMARY KEY
);`,
    ];

    const report = makeReport({
      existingFrameworkTables: ['flow_executions'],
      tables: [
        {
          tableName: 'flow_executions',
          exists: true,
          columnDrifts: [{ column: 'lease_owner', kind: 'missing_in_db', expected: 'text' }],
        },
      ],
    });

    const { statements, summary } = rewriteFrameworkDriftMigration(stmts, report);
    expect(statements.join('\n')).not.toContain('ALTER TABLE');
    expect(summary.warnings.some((w) => w.includes('lease_owner'))).toBe(true);
    expect(summary.droppedCreateTables).toEqual(['flow_executions']);
  });

  it('handles mixed migrations: rewrite + new framework table + entity table + index wrapping in one go', () => {
    const stmts = [
      // Existing framework table needs columns added
      `CREATE TABLE "flow_executions" (
\t"id" uuid PRIMARY KEY,
\t"lease_owner" text,
\t"lease_expires_at" timestamp with time zone
);`,
      // New framework table — should be preserved
      `CREATE TABLE "documents" (
\t"id" varchar(255) PRIMARY KEY,
\t"source" varchar(1024) NOT NULL
);`,
      // User entity table — passes through
      `CREATE TABLE "project" (
\t"id" uuid PRIMARY KEY,
\t"name" text
);`,
      // Index — wrapped
      `CREATE INDEX "flow_exec_lease_idx" ON "flow_executions" ("status","lease_expires_at");`,
      // Another index — wrapped
      `CREATE INDEX "documents_tenant_id_idx" ON "documents" ("tenant_id");`,
    ];

    const report = makeReport({
      hasDrift: true,
      existingFrameworkTables: ['flow_executions'],
      missingFrameworkTables: ['documents'],
      tables: [
        {
          tableName: 'flow_executions',
          exists: true,
          columnDrifts: [
            { column: 'lease_owner', kind: 'missing_in_db', expected: 'text' },
            {
              column: 'lease_expires_at',
              kind: 'missing_in_db',
              expected: 'timestamp with time zone',
            },
          ],
        },
        { tableName: 'documents', exists: false, columnDrifts: [] },
      ],
    });

    const { statements, summary } = rewriteFrameworkDriftMigration(stmts, report);
    const joined = statements.join('\n');

    expect(joined).not.toMatch(/CREATE\s+TABLE\s+"flow_executions"/i);
    expect(joined).toMatch(/CREATE\s+TABLE\s+"documents"/i);
    expect(joined).toMatch(/CREATE\s+TABLE\s+"project"/i);
    expect(statements).toContain('ALTER TABLE "flow_executions" ADD COLUMN "lease_owner" text;');
    expect(statements).toContain(
      'ALTER TABLE "flow_executions" ADD COLUMN "lease_expires_at" timestamp with time zone;',
    );
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS "flow_exec_lease_idx"');
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS "documents_tenant_id_idx"');

    expect(summary.alteredTables).toEqual([
      { table: 'flow_executions', addedColumns: ['lease_owner', 'lease_expires_at'] },
    ]);
    expect(summary.wrappedIndexes).toEqual(['flow_exec_lease_idx', 'documents_tenant_id_idx']);
  });

  it('emits one statement per ALTER (not a concatenated string) so the caller can join freely', () => {
    const stmts = [
      `CREATE TABLE "flow_executions" (
\t"id" uuid PRIMARY KEY,
\t"lease_owner" text,
\t"lease_expires_at" timestamp with time zone
);`,
      `CREATE INDEX "flow_exec_lease_idx" ON "flow_executions" ("lease_expires_at");`,
    ];

    const report = makeReport({
      existingFrameworkTables: ['flow_executions'],
      tables: [
        {
          tableName: 'flow_executions',
          exists: true,
          columnDrifts: [
            { column: 'lease_owner', kind: 'missing_in_db', expected: 'text' },
            {
              column: 'lease_expires_at',
              kind: 'missing_in_db',
              expected: 'timestamp with time zone',
            },
          ],
        },
      ],
    });

    const { statements } = rewriteFrameworkDriftMigration(stmts, report);
    // 2 ALTERs + 1 CREATE INDEX = 3 array entries
    expect(statements).toHaveLength(3);
    for (const s of statements) {
      expect(s).not.toContain('--> statement-breakpoint');
    }
  });

  it('leaves statements untouched when there is no framework drift and no indexes to wrap', () => {
    const stmts = [
      `CREATE TABLE "project" (
\t"id" uuid PRIMARY KEY,
\t"name" text
);`,
    ];
    const { statements, summary } = rewriteFrameworkDriftMigration(stmts, makeReport({}));
    expect(statements).toEqual(stmts);
    expect(rewriteHadEffect(summary)).toBe(false);
  });

  it('skips empty/whitespace-only input statements', () => {
    const stmts = ['', '   \n  ', `CREATE TABLE "project" ("id" uuid PRIMARY KEY);`];
    const { statements } = rewriteFrameworkDriftMigration(stmts, makeReport({}));
    expect(statements).toEqual([`CREATE TABLE "project" ("id" uuid PRIMARY KEY);`]);
  });
});

describe('ADD COLUMN idempotency', () => {
  it('rewrites ALTER TABLE … ADD COLUMN to ADD COLUMN IF NOT EXISTS', () => {
    const stmts = [`ALTER TABLE "timeline_event" ADD COLUMN "evidence" jsonb;`];
    const { statements, summary } = rewriteFrameworkDriftMigration(stmts, makeReport({}));
    expect(statements[0]).toBe(
      `ALTER TABLE "timeline_event" ADD COLUMN IF NOT EXISTS "evidence" jsonb;`,
    );
    expect(summary.idempotentAddColumns).toEqual(['"timeline_event"."evidence"']);
  });

  it('does not double-wrap ADD COLUMN IF NOT EXISTS', () => {
    const stmts = [`ALTER TABLE "x" ADD COLUMN IF NOT EXISTS "y" text;`];
    const { statements, summary } = rewriteFrameworkDriftMigration(stmts, makeReport({}));
    expect(statements).toEqual(stmts);
    expect(summary.idempotentAddColumns).toEqual([]);
  });

  it('handles multiple ADD COLUMN clauses in a single ALTER TABLE statement', () => {
    const stmts = [`ALTER TABLE "x" ADD COLUMN "a" text, ADD COLUMN "b" int;`];
    const { statements, summary } = rewriteFrameworkDriftMigration(stmts, makeReport({}));
    expect(statements[0]).toBe(
      `ALTER TABLE "x" ADD COLUMN IF NOT EXISTS "a" text, ADD COLUMN IF NOT EXISTS "b" int;`,
    );
    expect(summary.idempotentAddColumns).toEqual(['"x"."a","b"']);
  });

  it('does not rewrite ALTER TABLE … ADD CONSTRAINT or ALTER COLUMN', () => {
    const stmts = [
      `ALTER TABLE "x" ADD CONSTRAINT "c" UNIQUE ("a");`,
      `ALTER TABLE "x" ALTER COLUMN "a" SET NOT NULL;`,
      `ALTER TABLE "x" DROP COLUMN "b";`,
    ];
    const { statements, summary } = rewriteFrameworkDriftMigration(stmts, makeReport({}));
    expect(statements).toEqual(stmts);
    expect(summary.idempotentAddColumns).toEqual([]);
  });
});

describe('formatRewriteSummary', () => {
  it('produces empty output when nothing was rewritten', () => {
    expect(
      formatRewriteSummary({
        alteredTables: [],
        droppedCreateTables: [],
        wrappedIndexes: [],
        idempotentAddColumns: [],
        warnings: [],
      }),
    ).toEqual([]);
  });

  it('formats altered, dropped, wrapped, idempotent, and warning sections', () => {
    const lines = formatRewriteSummary({
      alteredTables: [{ table: 'flow_executions', addedColumns: ['lease_owner'] }],
      droppedCreateTables: ['event_outbox'],
      wrappedIndexes: ['idx_a', 'idx_b'],
      idempotentAddColumns: ['"timeline_event"."evidence"'],
      warnings: ['something is off'],
    });
    const out = lines.join('\n');
    expect(out).toContain('flow_executions: lease_owner');
    expect(out).toContain('event_outbox');
    expect(out).toContain('2 CREATE INDEX');
    expect(out).toContain('1 ALTER TABLE ADD COLUMN');
    expect(out).toContain('something is off');
  });
});
