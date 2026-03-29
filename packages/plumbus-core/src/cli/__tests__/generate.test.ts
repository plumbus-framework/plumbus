import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { field } from '../../fields/index.js';
import type { CapabilityContract, CapabilityEffects } from '../../types/capability.js';
import type { EntityDefinition } from '../../types/entity.js';
import type { EventDefinition } from '../../types/event.js';
import type { FlowDefinition } from '../../types/flow.js';
import {
  ensureTsconfigIncludesGenerated,
  generateAll,
  generateCapabilityNameType,
  generateCapabilityTypes,
  generateClientFunction,
  generateDataServiceMap,
  generateEntityInterface,
  generateEntityTypeFile,
  generateEventNameType,
  generateFlowNameType,
  generateManifestEntry,
  generateOpenApiPath,
  generatePlumbusDeclaration,
  generateReactHook,
  zodTypeToString,
} from '../commands/generate.js';

function mockCapability(overrides?: Partial<CapabilityContract>): CapabilityContract {
  return {
    name: 'getInvoice',
    kind: 'query',
    domain: 'billing',
    input: z.object({ id: z.string() }),
    output: z.object({ total: z.number() }),
    effects: { data: [], events: [], external: [], ai: false } satisfies CapabilityEffects,
    handler: async () => ({ total: 100 }),
    ...overrides,
  };
}

describe('zodTypeToString', () => {
  it('handles primitive types', () => {
    expect(zodTypeToString(z.string())).toBe('string');
    expect(zodTypeToString(z.number())).toBe('number');
    expect(zodTypeToString(z.boolean())).toBe('boolean');
    expect(zodTypeToString(z.date())).toBe('Date');
  });

  it('handles ZodObject with shape', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = zodTypeToString(schema);
    expect(result).toContain('name: string;');
    expect(result).toContain('age: number;');
  });

  it('handles empty ZodObject', () => {
    expect(zodTypeToString(z.object({}))).toBe('Record<string, never>');
  });

  it('handles ZodArray', () => {
    expect(zodTypeToString(z.array(z.string()))).toBe('string[]');
  });

  it('handles ZodArray of union with parentheses', () => {
    const schema = z.array(z.union([z.string(), z.number()]));
    expect(zodTypeToString(schema)).toBe('(string | number)[]');
  });

  it('handles ZodOptional', () => {
    expect(zodTypeToString(z.string().optional())).toBe('string');
  });

  it('marks optional fields in objects', () => {
    const schema = z.object({ name: z.string().optional() });
    expect(zodTypeToString(schema)).toContain('name?: string;');
  });

  it('handles ZodNullable', () => {
    expect(zodTypeToString(z.string().nullable())).toBe('string | null');
  });

  it('handles ZodDefault', () => {
    expect(zodTypeToString(z.string().default('hi'))).toBe('string');
  });

  it('handles ZodEnum', () => {
    expect(zodTypeToString(z.enum(['a', 'b', 'c']))).toBe('"a" | "b" | "c"');
  });

  it('handles ZodLiteral', () => {
    expect(zodTypeToString(z.literal('hello'))).toBe('"hello"');
    expect(zodTypeToString(z.literal(42))).toBe('42');
  });

  it('handles ZodUnion', () => {
    expect(zodTypeToString(z.union([z.string(), z.number()]))).toBe('string | number');
  });

  it('handles ZodRecord', () => {
    expect(zodTypeToString(z.record(z.string(), z.unknown()))).toBe('Record<string, unknown>');
  });

  it('handles ZodVoid, ZodNull, ZodUndefined', () => {
    expect(zodTypeToString(z.void())).toBe('void');
    expect(zodTypeToString(z.null())).toBe('null');
    expect(zodTypeToString(z.undefined())).toBe('undefined');
  });

  it('handles ZodAny and ZodUnknown', () => {
    expect(zodTypeToString(z.any())).toBe('any');
    expect(zodTypeToString(z.unknown())).toBe('unknown');
  });

  it('handles nested objects', () => {
    const schema = z.object({
      address: z.object({ city: z.string(), zip: z.string() }),
    });
    const result = zodTypeToString(schema);
    expect(result).toContain('address: {');
    expect(result).toContain('city: string;');
    expect(result).toContain('zip: string;');
  });
});

describe('generateCapabilityTypes', () => {
  it('generates Input and Output types from Zod schemas', () => {
    const cap = mockCapability();
    const result = generateCapabilityTypes(cap);
    expect(result).toContain('export type GetInvoiceInput = {');
    expect(result).toContain('id: string;');
    expect(result).toContain('export type GetInvoiceOutput = {');
    expect(result).toContain('total: number;');
  });

  it('uses PascalCase for type names', () => {
    const cap = mockCapability({ name: 'createOrderItem' });
    const result = generateCapabilityTypes(cap);
    expect(result).toContain('export type CreateOrderItemInput');
    expect(result).toContain('export type CreateOrderItemOutput');
  });
});

describe('generateCapabilityNameType', () => {
  it('generates a union type of capability names', () => {
    const caps = [mockCapability({ name: 'getInvoice' }), mockCapability({ name: 'createOrder' })];
    const result = generateCapabilityNameType(caps);
    expect(result).toBe('export type CapabilityName = "getInvoice" | "createOrder";');
  });

  it('generates never for empty capabilities', () => {
    expect(generateCapabilityNameType([])).toBe('export type CapabilityName = never;');
  });
});

describe('plumbus generate', () => {
  describe('generateClientFunction', () => {
    it('generates GET for query capabilities', () => {
      const fn = generateClientFunction(mockCapability());
      expect(fn).toContain('GET');
      expect(fn).toContain('/api/billing/get-invoice');
      expect(fn).toContain('getInvoice');
    });

    it('generates POST for action capabilities', () => {
      const fn = generateClientFunction(mockCapability({ kind: 'action', name: 'createInvoice' }));
      expect(fn).toContain('POST');
      expect(fn).toContain('JSON.stringify(input)');
    });
  });

  describe('generateReactHook', () => {
    it('generates query hook with useEffect pattern', () => {
      const hook = generateReactHook(mockCapability());
      expect(hook).toContain('useGetInvoice');
      expect(hook).toContain('useEffect');
      expect(hook).toContain('loading');
    });

    it('generates mutation hook for actions', () => {
      const hook = generateReactHook(mockCapability({ kind: 'action', name: 'createOrder' }));
      expect(hook).toContain('useCreateOrder');
      expect(hook).toContain('mutate');
    });
  });

  describe('generateOpenApiPath', () => {
    it('generates correct OpenAPI path entry', () => {
      const path = generateOpenApiPath(mockCapability());
      expect(path).toHaveProperty('/api/billing/get-invoice');
    });
  });

  describe('generateManifestEntry', () => {
    it('includes all contract metadata', () => {
      const entry = generateManifestEntry(mockCapability());
      expect(entry.name).toBe('getInvoice');
      expect(entry.kind).toBe('query');
      expect(entry.domain).toBe('billing');
    });
  });

  describe('generateAll', () => {
    it('generates all artifacts for empty capability list', () => {
      const tmpDir = `/tmp/plumbus-test-gen-${Date.now()}`;
      const generated = generateAll([], tmpDir);
      expect(generated).toContain('capability-types.ts');
      expect(generated).toContain('clients/api.ts');
      expect(generated).toContain('clients/hooks.ts');
      expect(generated).toContain('openapi.json');
      expect(generated).toContain('manifest.json');
      expect(generated).toContain('entity-types.ts');
    });
  });
});

function mockEntity(overrides?: Partial<EntityDefinition>): EntityDefinition {
  return {
    name: 'User',
    description: 'Application user',
    fields: {
      id: field.id(),
      email: field.string({ required: true, unique: true }),
      name: field.string(),
      role: field.string({ default: 'user' }),
      isActive: field.boolean(),
      createdAt: field.timestamp(),
    },
    ...overrides,
  };
}

describe('Entity type generation', () => {
  describe('generateEntityInterface', () => {
    it('generates an interface with correct field types', () => {
      const result = generateEntityInterface(mockEntity());
      expect(result).toContain('export interface UserRecord {');
      expect(result).toContain('id: string;');
      expect(result).toContain('email: string;');
      expect(result).toContain('name?: string;');
      expect(result).toContain('role?: string;');
      expect(result).toContain('isActive?: boolean;');
      expect(result).toContain('createdAt?: Date;');
      expect(result).toContain('}');
    });

    it('marks id fields as non-optional', () => {
      const result = generateEntityInterface(mockEntity());
      expect(result).toContain('  id: string;');
      expect(result).not.toContain('id?');
    });

    it('marks required fields as non-optional', () => {
      const result = generateEntityInterface(mockEntity());
      expect(result).toContain('  email: string;');
      expect(result).not.toContain('email?');
    });

    it('auto-adds updatedAt for entities without it', () => {
      const result = generateEntityInterface(mockEntity());
      expect(result).toContain('updatedAt: Date;');
    });

    it('auto-adds tenantId for tenant-scoped entities', () => {
      const entity = mockEntity({ tenantScoped: true });
      const result = generateEntityInterface(entity);
      expect(result).toContain('tenantId: string;');
    });

    it('does not duplicate tenantId if already defined', () => {
      const entity = mockEntity({
        tenantScoped: true,
        fields: {
          id: field.id(),
          tenantId: field.string({ required: true }),
        },
      });
      const result = generateEntityInterface(entity);
      const matches = result.match(/tenantId/g);
      expect(matches).toHaveLength(1);
    });

    it('maps all field types correctly', () => {
      const entity = mockEntity({
        name: 'AllTypes',
        fields: {
          id: field.id(),
          name: field.string(),
          count: field.number(),
          price: field.decimal(),
          active: field.boolean(),
          ts: field.timestamp(),
          data: field.json(),
          status: field.enum(['active', 'inactive']),
          ownerId: field.relation({ entity: 'User', type: 'many-to-one' }),
        },
      });
      const result = generateEntityInterface(entity);
      expect(result).toContain('id: string;');
      expect(result).toContain('name?: string;');
      expect(result).toContain('count?: number;');
      expect(result).toContain('price?: number;');
      expect(result).toContain('active?: boolean;');
      expect(result).toContain('ts?: Date;');
      expect(result).toContain('data?: unknown;');
      expect(result).toContain('status?: "active" | "inactive";');
      expect(result).toContain('ownerId?: string;');
    });

    it('uses PascalCase for entity name', () => {
      const entity = mockEntity({ name: 'orderItem' });
      const result = generateEntityInterface(entity);
      expect(result).toContain('export interface OrderItemRecord {');
    });
  });

  describe('generateDataServiceMap', () => {
    it('generates a DataServiceMap with repository types', () => {
      const entities = [
        mockEntity(),
        mockEntity({ name: 'Order', fields: { id: field.id(), total: field.number() } }),
      ];
      const result = generateDataServiceMap(entities);
      expect(result).toContain('import type { Repository } from "@plumbus/core";');
      expect(result).toContain('export interface UserRecord {');
      expect(result).toContain('export interface OrderRecord {');
      expect(result).toContain('export interface DataServiceMap {');
      expect(result).toContain('User: Repository<UserRecord>;');
      expect(result).toContain('Order: Repository<OrderRecord>;');
    });
  });

  describe('generateEntityTypeFile', () => {
    it('generates a complete file with header', () => {
      const entities = [mockEntity()];
      const result = generateEntityTypeFile(entities);
      expect(result).toContain('// Auto-generated by `plumbus generate` — do not edit');
      expect(result).toContain('export interface UserRecord {');
      expect(result).toContain('export interface DataServiceMap {');
    });

    it('generates empty DataServiceMap for empty entity list', () => {
      const result = generateEntityTypeFile([]);
      expect(result).toContain('// Auto-generated by `plumbus generate` — do not edit');
      expect(result).toContain('export interface DataServiceMap {}');
    });
  });
});

function mockEvent(overrides?: Partial<EventDefinition>): EventDefinition {
  return {
    name: 'user.created',
    description: 'Emitted when a user is created',
    payload: z.object({ userId: z.string() }),
    ...overrides,
  };
}

function mockFlow(overrides?: Partial<FlowDefinition>): FlowDefinition {
  return {
    name: 'onboardUser',
    domain: 'auth',
    input: z.object({ userId: z.string() }),
    steps: [{ type: 'capability' as const, name: 'sendWelcomeEmail' }],
    ...overrides,
  };
}

describe('generateEventNameType', () => {
  it('generates a union type of event names', () => {
    const events = [mockEvent(), mockEvent({ name: 'order.completed' })];
    const result = generateEventNameType(events);
    expect(result).toBe('export type EventName = "user.created" | "order.completed";');
  });

  it('generates never for empty events', () => {
    expect(generateEventNameType([])).toBe('export type EventName = never;');
  });
});

describe('generateFlowNameType', () => {
  it('generates a union type of flow names', () => {
    const flows = [mockFlow(), mockFlow({ name: 'processOrder' })];
    const result = generateFlowNameType(flows);
    expect(result).toBe('export type FlowName = "onboardUser" | "processOrder";');
  });

  it('generates never for empty flows', () => {
    expect(generateFlowNameType([])).toBe('export type FlowName = never;');
  });
});

describe('generatePlumbusDeclaration', () => {
  it('generates a declare module block augmenting PlumbusRegistry', () => {
    const caps = [mockCapability({ name: 'getInvoice' }), mockCapability({ name: 'createOrder' })];
    const events = [mockEvent({ name: 'user.created' })];
    const flows = [mockFlow({ name: 'onboardUser' })];
    const entities = [mockEntity()];

    const result = generatePlumbusDeclaration(caps, events, flows, entities);

    expect(result).toContain('declare module "@plumbus/core"');
    expect(result).toContain('interface PlumbusRegistry');
    expect(result).toContain('capabilityName: "getInvoice" | "createOrder"');
    expect(result).toContain('eventName: "user.created"');
    expect(result).toContain('flowName: "onboardUser"');
    expect(result).toContain('User: Repository<UserRecord>');
    expect(result).toContain('import type { Repository } from "@plumbus/core"');
    expect(result).toContain('import type { UserRecord } from "./entity-types.js"');
  });

  it('generates never for empty collections', () => {
    const result = generatePlumbusDeclaration([], [], [], []);

    expect(result).toContain('capabilityName: never');
    expect(result).toContain('eventName: never');
    expect(result).toContain('flowName: never');
    expect(result).toContain('entities: Record<string, never>');
    expect(result).not.toContain('import type { Repository }');
  });

  it('includes auto-generated header comment', () => {
    const result = generatePlumbusDeclaration([], [], [], []);
    expect(result).toContain('Auto-generated by `plumbus generate`');
  });

  it('handles multiple entities in the entities map', () => {
    const entities = [
      mockEntity(),
      mockEntity({ name: 'Order', fields: { id: field.id(), total: field.number() } }),
    ];
    const result = generatePlumbusDeclaration([], [], [], entities);

    expect(result).toContain('User: Repository<UserRecord>');
    expect(result).toContain('Order: Repository<OrderRecord>');
    expect(result).toContain('import type { UserRecord } from "./entity-types.js"');
    expect(result).toContain('import type { OrderRecord } from "./entity-types.js"');
  });
});

describe('generateAll with events and flows', () => {
  it('includes plumbus.d.ts in generated artifacts', () => {
    const tmpDir = `/tmp/plumbus-test-gen-${Date.now()}`;
    const generated = generateAll([], tmpDir, [], [], []);
    expect(generated).toContain('plumbus.d.ts');
  });
});

describe('ensureTsconfigIncludesGenerated', () => {
  const tmpDir = `/tmp/plumbus-tsconfig-test-${Date.now()}`;
  const tsconfigPath = path.join(tmpDir, 'tsconfig.json');

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('adds .plumbus/generated to include array', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify({ compilerOptions: {}, include: ['app', 'config'] }),
    );

    const modified = ensureTsconfigIncludesGenerated(tsconfigPath);
    expect(modified).toBe(true);

    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
    expect(tsconfig.include).toContain('.plumbus/generated');
  });

  it('preserves JSONC comments when modifying', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const content = [
      '{',
      '  // Compiler settings',
      '  "compilerOptions": {},',
      '  "include": ["app"]',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(tsconfigPath, content);

    const modified = ensureTsconfigIncludesGenerated(tsconfigPath);
    expect(modified).toBe(true);

    const result = fs.readFileSync(tsconfigPath, 'utf-8');
    expect(result).toContain('// Compiler settings');
    expect(result).toContain('.plumbus/generated');
  });

  it('preserves trailing newline', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tsconfigPath, '{\n  "include": ["app"]\n}\n');

    ensureTsconfigIncludesGenerated(tsconfigPath);

    const result = fs.readFileSync(tsconfigPath, 'utf-8');
    expect(result.endsWith('\n')).toBe(true);
  });

  it('does not duplicate if already present', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify({ compilerOptions: {}, include: ['app', '.plumbus/generated'] }),
    );

    const modified = ensureTsconfigIncludesGenerated(tsconfigPath);
    expect(modified).toBe(false);

    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
    const count = tsconfig.include.filter((e: string) => e === '.plumbus/generated').length;
    expect(count).toBe(1);
  });

  it('returns false if tsconfig does not exist', () => {
    const modified = ensureTsconfigIncludesGenerated('/tmp/nonexistent-tsconfig-12345.json');
    expect(modified).toBe(false);
  });

  it('returns false if include is not an array', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: {} }));

    const modified = ensureTsconfigIncludesGenerated(tsconfigPath);
    expect(modified).toBe(false);
  });
});
