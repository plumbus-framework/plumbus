import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { field } from '../../fields/index.js';
import type { CapabilityContract, CapabilityEffects } from '../../types/capability.js';
import type { EntityDefinition } from '../../types/entity.js';
import {
  generateAll,
  generateCapabilityNameType,
  generateCapabilityTypes,
  generateClientFunction,
  generateDataServiceMap,
  generateEntityInterface,
  generateEntityTypeFile,
  generateManifestEntry,
  generateOpenApiPath,
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
