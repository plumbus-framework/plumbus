import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { FRAMEWORK_SCHEMA, getPgSchema } from '../../data/schema-generator.js';
import {
  createSpineDispatchTable,
  createTenantDurableTables,
  SPINE_DISPATCH_TABLE_NAME,
  TENANT_DURABLE_TABLE_NAMES,
} from '../schema.js';
import { OPAQUE_DISPATCH_FORBIDDEN_KEYS } from '../types.js';

async function generateDdl(exports: Record<string, unknown>): Promise<string> {
  const { generateDrizzleJson, generateMigration } = await import('drizzle-kit/api');
  const empty = await generateDrizzleJson({});
  const next = await generateDrizzleJson(exports);
  return (await generateMigration(empty, next)).join('\n');
}

describe('durable core schema', () => {
  it('names the tenant-local v1 tables', () => {
    expect([...TENANT_DURABLE_TABLE_NAMES]).toEqual([
      'execution_state',
      'step_execution',
      'wait_state',
      'terminal_state',
      'dispatch_outbox',
      'side_effect_log',
    ]);
    expect(SPINE_DISPATCH_TABLE_NAME).toBe('opaque_dispatch');
  });

  it('places tenant tables in core_plumbus when that schema is requested', () => {
    const tables = createTenantDurableTables(FRAMEWORK_SCHEMA);
    expect(getTableConfig(tables.executionState).schema).toBe('core_plumbus');
    expect(getTableConfig(tables.dispatchOutbox).schema).toBe('core_plumbus');
    expect(getTableConfig(tables.stepExecution).name).toBe('step_execution');
    expect(getTableConfig(tables.waitState).name).toBe('wait_state');
    expect(getTableConfig(tables.terminalState).name).toBe('terminal_state');
  });

  it('emits schema-qualified DDL for tenant durable tables', async () => {
    const tables = createTenantDurableTables(FRAMEWORK_SCHEMA);
    const sql = await generateDdl({
      ...tables,
      corePlumbus: getPgSchema(FRAMEWORK_SCHEMA),
    });
    expect(sql).toContain('CREATE SCHEMA "core_plumbus";');
    expect(sql).toContain('CREATE TABLE "core_plumbus"."execution_state"');
    expect(sql).toContain('CREATE TABLE "core_plumbus"."dispatch_outbox"');
    expect(sql).toContain('"revision" integer NOT NULL');
    expect(sql).toContain('"tenant_epoch" integer NOT NULL');
  });

  it('keeps spine dispatch free of private payload columns', () => {
    const table = createSpineDispatchTable();
    const config = getTableConfig(table);
    expect(config.schema).toBeUndefined();
    expect(config.name).toBe('opaque_dispatch');
    const columns = new Set(config.columns.map((column) => column.name));
    expect(columns.has('expected_revision')).toBe(true);
    expect(columns.has('tenant_epoch')).toBe(true);
    for (const forbidden of OPAQUE_DISPATCH_FORBIDDEN_KEYS) {
      expect(columns.has(forbidden)).toBe(false);
    }
  });
});
