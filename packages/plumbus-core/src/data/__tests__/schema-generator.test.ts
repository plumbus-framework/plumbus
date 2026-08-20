import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, uuid } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { field } from '../../fields/index.js';
import type { EntityDefinition } from '../../types/entity.js';
import {
  declaredPgSchemas,
  FRAMEWORK_SCHEMA,
  FRAMEWORK_SCHEMA_ENV_VAR,
  generateDrizzleSchema,
  generateSchemas,
  getPgSchema,
  resolveEntitySchemaName,
  resolveFrameworkSchema,
  tableBuilderFor,
} from '../schema-generator.js';

/** Minimal column for tables built straight through a table builder. */
function idColumn() {
  return uuid('id').defaultRandom().primaryKey();
}

function makeEntity(overrides: Partial<EntityDefinition> = {}): EntityDefinition {
  return {
    name: 'TestUser',
    fields: {
      id: field.id(),
      name: field.string({ required: true }),
      email: field.string({ required: true, unique: true }),
    },
    ...overrides,
  };
}

describe('generateDrizzleSchema', () => {
  it('creates a table with the snake_case entity name', () => {
    const table = generateDrizzleSchema(makeEntity());
    expect(getTableName(table)).toBe('test_user');
  });

  it('maps field types to correct column types', () => {
    const entity = makeEntity({
      name: 'AllTypes',
      fields: {
        id: field.id(),
        label: field.string(),
        count: field.number(),
        score: field.decimal(),
        active: field.boolean(),
        createdAt: field.timestamp(),
        meta: field.json(),
        status: field.enum(['active', 'disabled']),
        orgId: field.relation({ entity: 'Org', type: 'many-to-one' }),
      },
    });
    const table = generateDrizzleSchema(entity);
    const cols = getTableColumns(table);

    expect(cols.id).toBeDefined();
    expect(cols.label).toBeDefined();
    expect(cols.count).toBeDefined();
    expect(cols.score).toBeDefined();
    expect(cols.active).toBeDefined();
    expect(cols.createdAt).toBeDefined();
    expect(cols.meta).toBeDefined();
    expect(cols.status).toBeDefined();
    expect(cols.orgId).toBeDefined();
  });

  it('auto-adds createdAt and updatedAt when not in fields', () => {
    const entity = makeEntity({
      fields: {
        id: field.id(),
        name: field.string(),
      },
    });
    const table = generateDrizzleSchema(entity);
    const cols = getTableColumns(table);

    expect(cols.createdAt).toBeDefined();
    expect(cols.updatedAt).toBeDefined();
  });

  it('does not duplicate createdAt if already in fields', () => {
    const entity = makeEntity({
      fields: {
        id: field.id(),
        createdAt: field.timestamp(),
      },
    });
    const table = generateDrizzleSchema(entity);
    const cols = getTableColumns(table);
    expect(cols.createdAt).toBeDefined();
    // updatedAt still auto-added
    expect(cols.updatedAt).toBeDefined();
  });

  it('adds tenantId column for tenantScoped entities', () => {
    const entity = makeEntity({ tenantScoped: true });
    const table = generateDrizzleSchema(entity);
    const cols = getTableColumns(table);
    expect(cols.tenantId).toBeDefined();
  });

  it('does not add tenantId for non-tenantScoped entities', () => {
    const entity = makeEntity({ tenantScoped: false });
    const table = generateDrizzleSchema(entity);
    const cols = getTableColumns(table);
    expect(cols.tenantId).toBeUndefined();
  });

  it('handles empty indexes gracefully', () => {
    const entity = makeEntity({ indexes: [] });
    const table = generateDrizzleSchema(entity);
    expect(table).toBeDefined();
  });

  it('creates indexes for defined fields', () => {
    const entity = makeEntity({
      fields: {
        id: field.id(),
        name: field.string(),
        email: field.string(),
      },
      indexes: [['name'], ['name', 'email']],
    });
    const table = generateDrizzleSchema(entity);
    expect(table).toBeDefined();
  });

  it('emits a unique index for EntityIndexDefinition { unique: true }', () => {
    const entity = makeEntity({
      name: 'Indexed',
      fields: {
        id: field.id(),
        a: field.string(),
        b: field.string(),
        c: field.string(),
      },
      indexes: [{ columns: ['a', 'b'], unique: true }, ['c']],
    });
    const table = generateDrizzleSchema(entity);
    const cfg = getTableConfig(table);
    const byName = new Map(cfg.indexes.map((idx) => [idx.config.name, idx.config]));
    expect(byName.get('indexed_a_b_idx')?.unique).toBe(true);
    expect(byName.get('indexed_c_idx')?.unique).toBeFalsy();
  });
});

describe('generateSchemas', () => {
  it('generates schemas for multiple entities', () => {
    const entities = [makeEntity({ name: 'User' }), makeEntity({ name: 'Project' })];
    const schemas = generateSchemas(entities);
    expect(schemas.size).toBe(2);
    expect(schemas.has('User')).toBe(true);
    expect(schemas.has('Project')).toBe(true);
  });
});

// ── Schema namespacing ──

describe('resolveEntitySchemaName', () => {
  it('returns undefined without options (unqualified, as before)', () => {
    expect(resolveEntitySchemaName(makeEntity({ domain: 'billing' }))).toBeUndefined();
  });

  it('returns undefined for an empty options object', () => {
    expect(resolveEntitySchemaName(makeEntity({ domain: 'billing' }), {})).toBeUndefined();
  });

  it('uses the fixed schema for every entity when `schema` is set', () => {
    expect(resolveEntitySchemaName(makeEntity(), { schema: FRAMEWORK_SCHEMA })).toBe(
      'core_plumbus',
    );
    expect(
      resolveEntitySchemaName(makeEntity({ domain: 'billing' }), {
        schema: FRAMEWORK_SCHEMA,
        packageSchemaPrefix: 'pkg_',
      }),
    ).toBe('core_plumbus');
  });

  it('derives a package schema from the declared domain', () => {
    expect(
      resolveEntitySchemaName(makeEntity({ domain: 'billing' }), {
        coreSchema: 'core_platform',
        packageSchemaPrefix: 'pkg_',
      }),
    ).toBe('pkg_billing');
  });

  it('snake_cases and sanitizes the domain segment', () => {
    const options = { packageSchemaPrefix: 'pkg_' };
    expect(resolveEntitySchemaName(makeEntity({ domain: 'accountManagement' }), options)).toBe(
      'pkg_account_management',
    );
    expect(resolveEntitySchemaName(makeEntity({ domain: 'field-ops.eu' }), options)).toBe(
      'pkg_field_ops_eu',
    );
  });

  it('sends entities with no domain to the core schema', () => {
    expect(
      resolveEntitySchemaName(makeEntity(), {
        coreSchema: 'core_platform',
        packageSchemaPrefix: 'pkg_',
      }),
    ).toBe('core_platform');
  });

  it('sends declared core domains to the core schema despite the package prefix', () => {
    const options = {
      coreSchema: 'core_platform',
      packageSchemaPrefix: 'pkg_',
      coreDomains: ['identity', 'accessControl'],
    };
    expect(resolveEntitySchemaName(makeEntity({ domain: 'identity' }), options)).toBe(
      'core_platform',
    );
    expect(resolveEntitySchemaName(makeEntity({ domain: 'access-control' }), options)).toBe(
      'core_platform',
    );
    expect(resolveEntitySchemaName(makeEntity({ domain: 'billing' }), options)).toBe('pkg_billing');
  });

  it('falls back to the core schema when no package prefix is configured', () => {
    expect(
      resolveEntitySchemaName(makeEntity({ domain: 'billing' }), { coreSchema: 'core_platform' }),
    ).toBe('core_platform');
  });

  it('lets resolveSchema override every other rule', () => {
    const resolved = resolveEntitySchemaName(makeEntity({ domain: 'billing' }), {
      schema: 'core_platform',
      packageSchemaPrefix: 'pkg_',
      resolveSchema: (entity) => `tenant_${entity.name.toLowerCase()}`,
    });
    expect(resolved).toBe('tenant_testuser');
  });

  it('falls through to the remaining rules when resolveSchema returns undefined', () => {
    const resolved = resolveEntitySchemaName(makeEntity({ domain: 'billing' }), {
      packageSchemaPrefix: 'pkg_',
      resolveSchema: () => undefined,
    });
    expect(resolved).toBe('pkg_billing');
  });

  it('treats blank option values as unset', () => {
    expect(
      resolveEntitySchemaName(makeEntity({ domain: '   ' }), {
        schema: '  ',
        coreSchema: '  ',
        packageSchemaPrefix: 'pkg_',
      }),
    ).toBeUndefined();
  });
});

describe('generateDrizzleSchema schema qualification', () => {
  it('leaves the table unqualified when no options are given', () => {
    const table = generateDrizzleSchema(makeEntity({ domain: 'billing' }));
    expect(getTableConfig(table).schema).toBeUndefined();
  });

  it('leaves the table unqualified for an empty options object', () => {
    const table = generateDrizzleSchema(makeEntity({ domain: 'billing' }), {});
    expect(getTableConfig(table).schema).toBeUndefined();
  });

  it('qualifies the table with the resolved schema', () => {
    const table = generateDrizzleSchema(makeEntity({ domain: 'billing' }), {
      coreSchema: 'core_platform',
      packageSchemaPrefix: 'pkg_',
    });
    const config = getTableConfig(table);
    expect(config.schema).toBe('pkg_billing');
    expect(config.name).toBe('test_user');
  });

  it('keeps columns, indexes and tenant scoping intact when qualified', () => {
    const entity = makeEntity({
      name: 'Scoped',
      tenantScoped: true,
      indexes: [{ columns: ['name', 'email'], unique: true }],
    });
    const qualified = generateDrizzleSchema(entity, { coreSchema: 'core_platform' });
    const unqualified = generateDrizzleSchema(entity);

    expect(Object.keys(getTableColumns(qualified))).toEqual(
      Object.keys(getTableColumns(unqualified)),
    );
    const indexNames = getTableConfig(qualified).indexes.map((idx) => idx.config.name);
    expect(indexNames).toEqual(getTableConfig(unqualified).indexes.map((idx) => idx.config.name));
    expect(indexNames).toContain('scoped_name_email_idx');
    expect(indexNames).toContain('scoped_tenant_id_idx');
    expect(getTableColumns(qualified).tenantId).toBeDefined();
  });

  it('places each entity by its own domain in generateSchemas', () => {
    const schemas = generateSchemas(
      [
        makeEntity({ name: 'Ledger', domain: 'billing' }),
        makeEntity({ name: 'Principal', domain: 'identity' }),
        makeEntity({ name: 'Setting' }),
      ],
      {
        coreSchema: 'core_platform',
        packageSchemaPrefix: 'pkg_',
        coreDomains: ['identity'],
      },
    );

    const schemaOf = (entityName: string): string | undefined => {
      const table = schemas.get(entityName);
      if (!table) {
        throw new Error(`No table generated for entity "${entityName}"`);
      }
      return getTableConfig(table).schema;
    };

    expect(schemaOf('Ledger')).toBe('pkg_billing');
    expect(schemaOf('Principal')).toBe('core_platform');
    expect(schemaOf('Setting')).toBe('core_platform');
  });

  it('leaves every table unqualified in generateSchemas without options', () => {
    const schemas = generateSchemas([
      makeEntity({ name: 'Ledger', domain: 'billing' }),
      makeEntity({ name: 'Setting' }),
    ]);
    for (const table of schemas.values()) {
      expect(getTableConfig(table).schema).toBeUndefined();
    }
  });
});

describe('tableBuilderFor', () => {
  it('builds unqualified tables when no schema name is given', () => {
    const table = tableBuilderFor()('widget', { id: idColumn() });
    expect(getTableConfig(table).schema).toBeUndefined();
  });

  it('treats a blank schema name as unqualified', () => {
    const table = tableBuilderFor('   ')('widget', { id: idColumn() });
    expect(getTableConfig(table).schema).toBeUndefined();
  });

  it('places framework tenant-local tables in the framework schema', () => {
    const build = tableBuilderFor(FRAMEWORK_SCHEMA);
    const frameworkTables = [
      'audit_records',
      'event_outbox',
      'event_idempotency',
      'event_dead_letter',
      'flow_executions',
      'flow_dead_letter',
      'flow_schedules',
      'job_executions',
    ];

    for (const name of frameworkTables) {
      const table = build(name, { id: idColumn() });
      const config = getTableConfig(table);
      expect(config.schema).toBe('core_plumbus');
      expect(config.name).toBe(name);
    }
  });

  it('reuses one PgSchema instance per schema name', () => {
    const first = getPgSchema('core_reuse_probe');
    const second = getPgSchema('core_reuse_probe');
    expect(second).toBe(first);
    expect(declaredPgSchemas()).toContain(first);
  });

  it('records schemas created through tableBuilderFor so CREATE SCHEMA can be emitted', () => {
    tableBuilderFor('core_declared_probe')('widget', { id: idColumn() });
    expect(declaredPgSchemas().map((schema) => schema.schemaName)).toContain('core_declared_probe');
  });
});

describe('resolveFrameworkSchema', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is undefined when the variable is unset', () => {
    expect(resolveFrameworkSchema({})).toBeUndefined();
  });

  it('is undefined when the variable is blank', () => {
    expect(resolveFrameworkSchema({ [FRAMEWORK_SCHEMA_ENV_VAR]: '   ' })).toBeUndefined();
  });

  it('returns the trimmed configured schema name', () => {
    expect(resolveFrameworkSchema({ [FRAMEWORK_SCHEMA_ENV_VAR]: ' core_plumbus ' })).toBe(
      'core_plumbus',
    );
  });

  it('reads process.env by default', () => {
    vi.stubEnv(FRAMEWORK_SCHEMA_ENV_VAR, FRAMEWORK_SCHEMA);
    expect(resolveFrameworkSchema()).toBe('core_plumbus');
  });

  it('leaves framework tables unqualified when the variable is unset', () => {
    vi.stubEnv(FRAMEWORK_SCHEMA_ENV_VAR, '');
    const table = tableBuilderFor(resolveFrameworkSchema())('audit_records', { id: idColumn() });
    expect(getTableConfig(table).schema).toBeUndefined();
  });
});

// ── Generated DDL ──
//
// These assert the SQL drizzle-kit actually produces from the generated tables.
// The unqualified string is pinned byte-for-byte: it is the output the
// generator produced before schema namespacing existed, and must not move.

const UNQUALIFIED_DDL = [
  'CREATE TABLE "test_user" (',
  '\t"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,',
  '\t"name" text NOT NULL,',
  '\t"email" text NOT NULL,',
  '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,',
  '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,',
  '\tCONSTRAINT "test_user_email_unique" UNIQUE("email")',
  ');',
  '',
  'CREATE INDEX "test_user_name_idx" ON "test_user" USING btree ("name");',
].join('\n');

const QUALIFIED_DDL = [
  'CREATE SCHEMA "pkg_billing";',
  '',
  'CREATE TABLE "pkg_billing"."test_user" (',
  '\t"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,',
  '\t"name" text NOT NULL,',
  '\t"email" text NOT NULL,',
  '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,',
  '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,',
  '\tCONSTRAINT "test_user_email_unique" UNIQUE("email")',
  ');',
  '',
  'CREATE INDEX "test_user_name_idx" ON "pkg_billing"."test_user" USING btree ("name");',
].join('\n');

async function generateDdl(exports: Record<string, unknown>): Promise<string> {
  const { generateDrizzleJson, generateMigration } = await import('drizzle-kit/api');
  const empty = await generateDrizzleJson({});
  const next = await generateDrizzleJson(exports);
  return (await generateMigration(empty, next)).join('\n');
}

describe('generated DDL', () => {
  const ddlEntity = makeEntity({ indexes: [['name']] });

  it('emits unqualified DDL byte-for-byte when no options are given', async () => {
    const sql = await generateDdl({ testUser: generateDrizzleSchema(ddlEntity) });
    expect(sql).toBe(UNQUALIFIED_DDL);
  });

  it('emits the same bytes for an empty options object', async () => {
    const sql = await generateDdl({ testUser: generateDrizzleSchema(ddlEntity, {}) });
    expect(sql).toBe(UNQUALIFIED_DDL);
  });

  it('emits no CREATE SCHEMA for a domain-carrying entity without options', async () => {
    const sql = await generateDdl({
      testUser: generateDrizzleSchema({ ...ddlEntity, domain: 'billing' }),
    });
    expect(sql).toBe(UNQUALIFIED_DDL);
    expect(sql).not.toContain('CREATE SCHEMA');
  });

  it('emits schema-qualified DDL with CREATE SCHEMA when a schema is resolved', async () => {
    const table = generateDrizzleSchema(
      { ...ddlEntity, domain: 'billing' },
      { coreSchema: 'core_platform', packageSchemaPrefix: 'pkg_' },
    );
    const sql = await generateDdl({ testUser: table, pkgBilling: getPgSchema('pkg_billing') });
    expect(sql).toBe(QUALIFIED_DDL);
  });

  it('omits CREATE SCHEMA when the PgSchema instance is not handed to drizzle-kit', async () => {
    const table = generateDrizzleSchema(
      { ...ddlEntity, domain: 'billing' },
      { packageSchemaPrefix: 'pkg_' },
    );
    const sql = await generateDdl({ testUser: table });
    expect(sql).toContain('CREATE TABLE "pkg_billing"."test_user"');
    expect(sql).not.toContain('CREATE SCHEMA');
  });

  it('emits framework tenant-local tables into the framework schema', async () => {
    const build = tableBuilderFor(FRAMEWORK_SCHEMA);
    const sql = await generateDdl({
      auditRecords: build('audit_records', { id: idColumn() }),
      flowExecutions: build('flow_executions', { id: idColumn() }),
      corePlumbus: getPgSchema(FRAMEWORK_SCHEMA),
    });
    expect(sql).toContain('CREATE SCHEMA "core_plumbus";');
    expect(sql).toContain('CREATE TABLE "core_plumbus"."audit_records"');
    expect(sql).toContain('CREATE TABLE "core_plumbus"."flow_executions"');
  });
});
