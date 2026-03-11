import type { CapabilityContract } from 'plumbus-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  extractFieldHint,
  extractFormHints,
  generateFormHintsCode,
  generateFormHintsModule,
} from '../form-generator.js';

// ── Fixtures ──

function makeCap(input: z.ZodTypeAny): CapabilityContract {
  return {
    name: 'createUser',
    kind: 'action',
    domain: 'users',
    description: 'Create a user',
    input,
    output: z.object({ id: z.string() }),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ id: '1' }),
  } as CapabilityContract;
}

// ── extractFieldHint ──

describe('extractFieldHint', () => {
  it('extracts string field hints', () => {
    const hint = extractFieldHint('username', z.string());
    expect(hint.name).toBe('username');
    expect(hint.label).toBe('Username');
    expect(hint.fieldType).toBe('text');
    expect(hint.required).toBe(true);
    expect(hint.zodType).toBe('ZodString');
  });

  it('extracts number field hints', () => {
    const hint = extractFieldHint('age', z.number());
    expect(hint.fieldType).toBe('number');
    expect(hint.zodType).toBe('ZodNumber');
    expect(hint.required).toBe(true);
  });

  it('extracts boolean field hints', () => {
    const hint = extractFieldHint('isActive', z.boolean());
    expect(hint.fieldType).toBe('boolean');
    expect(hint.zodType).toBe('ZodBoolean');
  });

  it('extracts enum field hints with options', () => {
    const hint = extractFieldHint('role', z.enum(['admin', 'user', 'guest']));
    expect(hint.fieldType).toBe('select');
    expect(hint.options).toEqual(['admin', 'user', 'guest']);
  });

  it('marks optional fields as not required', () => {
    const hint = extractFieldHint('nickname', z.string().optional());
    expect(hint.required).toBe(false);
  });

  it('marks fields with defaults as not required', () => {
    const hint = extractFieldHint('role', z.string().default('user'));
    expect(hint.required).toBe(false);
    expect(hint.defaultValue).toBe('user');
  });

  it('extracts min/max validation from strings', () => {
    const hint = extractFieldHint('name', z.string().min(2).max(50));
    expect(hint.validation.minLength).toBe(2);
    expect(hint.validation.maxLength).toBe(50);
  });

  it('extracts min/max validation from numbers', () => {
    const hint = extractFieldHint('age', z.number().min(0).max(150));
    expect(hint.validation.min).toBe(0);
    expect(hint.validation.max).toBe(150);
  });

  it('extracts email pattern', () => {
    const hint = extractFieldHint('email', z.string().email());
    expect(hint.validation.pattern).toBe('email');
  });

  it('extracts url pattern', () => {
    const hint = extractFieldHint('website', z.string().url());
    expect(hint.validation.pattern).toBe('url');
  });

  it('extracts regex pattern', () => {
    const hint = extractFieldHint('code', z.string().regex(/^[A-Z]{3}$/));
    expect(hint.validation.pattern).toBe('^[A-Z]{3}$');
  });

  it('handles nullable fields', () => {
    const hint = extractFieldHint('bio', z.string().nullable());
    expect(hint.validation.nullable).toBe(true);
  });

  it('generates label from camelCase', () => {
    const hint = extractFieldHint('firstName', z.string());
    expect(hint.label).toBe('First Name');
  });

  it('generates label from snake_case', () => {
    const hint = extractFieldHint('first_name', z.string());
    expect(hint.label).toBe('First Name');
  });

  it('extracts description from .describe()', () => {
    const hint = extractFieldHint('email', z.string().describe('User email address'));
    expect(hint.description).toBe('User email address');
  });

  it('maps object types to textarea', () => {
    const hint = extractFieldHint('metadata', z.object({ key: z.string() }));
    expect(hint.fieldType).toBe('textarea');
  });

  it('maps array types to textarea', () => {
    const hint = extractFieldHint('tags', z.array(z.string()));
    expect(hint.fieldType).toBe('textarea');
  });

  it('maps date type to date', () => {
    const hint = extractFieldHint('birthday', z.date());
    expect(hint.fieldType).toBe('date');
  });
});

// ── extractFormHints ──

describe('extractFormHints', () => {
  it('extracts all fields from a capability input schema', () => {
    const cap = makeCap(
      z.object({
        name: z.string().min(1),
        email: z.string().email(),
        age: z.number().optional(),
        role: z.enum(['admin', 'user']),
      }),
    );
    const hints = extractFormHints(cap);

    expect(hints.capabilityName).toBe('createUser');
    expect(hints.kind).toBe('action');
    expect(hints.fields).toHaveLength(4);

    const names = hints.fields.map((f) => f.name);
    expect(names).toContain('name');
    expect(names).toContain('email');
    expect(names).toContain('age');
    expect(names).toContain('role');
  });

  it('returns empty fields for non-object schemas', () => {
    const cap = makeCap(z.string());
    const hints = extractFormHints(cap);
    expect(hints.fields).toHaveLength(0);
  });

  it('preserves field order', () => {
    const cap = makeCap(
      z.object({
        alpha: z.string(),
        beta: z.number(),
        gamma: z.boolean(),
      }),
    );
    const hints = extractFormHints(cap);
    expect(hints.fields[0]?.name).toBe('alpha');
    expect(hints.fields[1]?.name).toBe('beta');
    expect(hints.fields[2]?.name).toBe('gamma');
  });

  it('handles complex nested schemas', () => {
    const cap = makeCap(
      z.object({
        name: z.string(),
        address: z.object({ street: z.string(), city: z.string() }),
      }),
    );
    const hints = extractFormHints(cap);
    expect(hints.fields).toHaveLength(2);
    const addressField = hints.fields.find((f) => f.name === 'address');
    expect(addressField?.fieldType).toBe('textarea');
  });
});

// ── generateFormHintsCode ──

describe('generateFormHintsCode', () => {
  it('generates a TypeScript constant', () => {
    const cap = makeCap(z.object({ name: z.string() }));
    const code = generateFormHintsCode(cap);
    expect(code).toContain('export const CreateUserFormHints');
    expect(code).toContain('as const');
  });

  it('includes field metadata in the output', () => {
    const cap = makeCap(
      z.object({
        email: z.string().email(),
        age: z.number().min(0).optional(),
      }),
    );
    const code = generateFormHintsCode(cap);
    expect(code).toContain('"email"');
    expect(code).toContain('"age"');
    expect(code).toContain('"capabilityName": "createUser"');
  });
});

// ── generateFormHintsModule ──

describe('generateFormHintsModule', () => {
  it('generates a module exporting all capability hints', () => {
    const caps = [
      makeCap(z.object({ name: z.string() })),
      {
        ...makeCap(z.object({ query: z.string() })),
        name: 'searchUsers',
        kind: 'query' as const,
      } as CapabilityContract,
    ];
    const code = generateFormHintsModule(caps);
    expect(code).toContain('Auto-generated by @plumbus/ui');
    expect(code).toContain('CreateUserFormHints');
    expect(code).toContain('SearchUsersFormHints');
  });

  it('generates empty module for no capabilities', () => {
    const code = generateFormHintsModule([]);
    expect(code).toContain('Auto-generated by @plumbus/ui');
    // Should be just the header comment and empty line
    const lines = code.trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(2);
  });
});
