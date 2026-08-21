import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { FRAMEWORK_SCHEMA } from '../../data/schema-generator.js';
import { createTenantApprovalTables, TENANT_APPROVAL_TABLE_NAMES } from '../schema.js';

describe('tenant approval schema', () => {
  it('names the v1 human-task tables', () => {
    expect([...TENANT_APPROVAL_TABLE_NAMES]).toEqual([
      'human_task',
      'approval_request',
      'approval_decision',
    ]);
  });

  it('places tenant tables in core_plumbus when that schema is requested', () => {
    const tables = createTenantApprovalTables(FRAMEWORK_SCHEMA);
    expect(getTableConfig(tables.humanTask).schema).toBe('core_plumbus');
    expect(getTableConfig(tables.approvalRequest).name).toBe('approval_request');
    expect(getTableConfig(tables.approvalDecision).name).toBe('approval_decision');
  });
});
