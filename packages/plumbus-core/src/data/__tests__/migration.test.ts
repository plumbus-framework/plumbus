import { getTableName } from 'drizzle-orm';
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { field } from '../../fields/index.js';
import type { EntityDefinition } from '../../types/entity.js';
import { collectSchemas } from '../migration.js';

function makeEntity(name: string): EntityDefinition {
  return {
    name,
    fields: {
      id: field.id(),
      label: field.string({ required: true }),
    },
  };
}

function getSchema(schemas: Record<string, PgTableWithColumns<any>>, key: string) {
  const table = schemas[key];
  expect(table).toBeDefined();
  return table as PgTableWithColumns<any>;
}

describe('collectSchemas', () => {
  it('includes user-defined entity tables', () => {
    const schemas = collectSchemas([makeEntity('Order'), makeEntity('Customer')]);
    expect(schemas.Order).toBeDefined();
    expect(schemas.Customer).toBeDefined();
  });

  it('includes the audit_records framework table', () => {
    const schemas = collectSchemas([]);
    expect(getTableName(getSchema(schemas, '__audit_records'))).toBe('audit_records');
  });

  it('includes event outbox framework tables', () => {
    const schemas = collectSchemas([]);
    expect(getTableName(getSchema(schemas, '__event_outbox'))).toBe('event_outbox');
    expect(getTableName(getSchema(schemas, '__event_idempotency'))).toBe('event_idempotency');
    expect(getTableName(getSchema(schemas, '__event_dead_letter'))).toBe('event_dead_letter');
  });

  it('includes flow framework tables', () => {
    const schemas = collectSchemas([]);
    expect(getTableName(getSchema(schemas, '__flow_executions'))).toBe('flow_executions');
    expect(getTableName(getSchema(schemas, '__flow_dead_letter'))).toBe('flow_dead_letter');
    expect(getTableName(getSchema(schemas, '__flow_schedules'))).toBe('flow_schedules');
  });

  it('includes RAG document tables', () => {
    const schemas = collectSchemas([]);
    expect(getTableName(getSchema(schemas, '__documents'))).toBe('documents');
    expect(getTableName(getSchema(schemas, '__document_chunks'))).toBe('document_chunks');
  });

  it('includes all 9 framework tables with zero entities', () => {
    const schemas = collectSchemas([]);
    const frameworkKeys = Object.keys(schemas).filter((k) => k.startsWith('__'));
    expect(frameworkKeys).toHaveLength(9);
  });
});
