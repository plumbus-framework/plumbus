import { describe, expect, it } from 'vitest';
import { field } from '../../fields/index.js';
import type { EntityDefinition } from '../../types/entity.js';
import { createTestContext, createTestData } from '../context.js';
import { validateRecord } from '../field-validation.js';

function unreachable(msg: string): never {
  throw new Error(msg);
}

const timelineEventEntity: EntityDefinition = {
  name: 'TimelineEvent',
  fields: {
    id: field.id(),
    projectId: field.relation({ entity: 'Project', type: 'many-to-one' }),
    title: field.string({ required: true }),
    description: field.string({ nullable: true }),
    confidence: field.number({ nullable: true }),
    score: field.decimal({ nullable: true }),
    active: field.boolean(),
    sourceType: field.enum(['interview_message', 'media_asset'], { required: true }),
    meta: field.json(),
    createdAt: field.timestamp({ required: true }),
  },
};

describe('validateRecord', () => {
  const fields = timelineEventEntity.fields;

  it('accepts valid data with no errors', () => {
    const errors = validateRecord('TimelineEvent', fields, {
      projectId: 'proj-1',
      title: 'Event',
      confidence: 5,
      score: 0.7,
      active: true,
      sourceType: 'interview_message',
      createdAt: new Date(),
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects a float in an integer (number) field', () => {
    const errors = validateRecord('TimelineEvent', fields, {
      title: 'Event',
      confidence: 0.7,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe('confidence');
    expect(errors[0]?.expected).toBe('integer');
    expect(errors[0]?.actual).toBe('float');
  });

  it('accepts an integer in a number field', () => {
    const errors = validateRecord('TimelineEvent', fields, {
      confidence: 5,
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts a float in a decimal field', () => {
    const errors = validateRecord('TimelineEvent', fields, {
      score: 0.7,
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects a string in a number field', () => {
    const errors = validateRecord('TimelineEvent', fields, {
      confidence: '5',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.expected).toBe('integer');
  });

  it('rejects a number in a string field', () => {
    const errors = validateRecord('TimelineEvent', fields, {
      title: 42,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe('title');
    expect(errors[0]?.expected).toBe('string');
  });

  it('rejects an invalid enum value', () => {
    const errors = validateRecord('TimelineEvent', fields, {
      sourceType: 'unknown_source',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe('sourceType');
    expect(errors[0]?.expected).toContain('interview_message');
  });

  it('accepts valid enum values', () => {
    const errors = validateRecord('TimelineEvent', fields, {
      sourceType: 'media_asset',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects a string in a boolean field', () => {
    const errors = validateRecord('TimelineEvent', fields, {
      active: 'true',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.expected).toBe('boolean');
  });

  it('skips null values (nullable handling is separate)', () => {
    const errors = validateRecord('TimelineEvent', fields, {
      confidence: null,
      description: null,
    });
    expect(errors).toHaveLength(0);
  });

  it('skips fields not in the entity definition', () => {
    const errors = validateRecord('TimelineEvent', fields, {
      unknownField: 'anything',
    });
    expect(errors).toHaveLength(0);
  });

  it('reports multiple errors at once', () => {
    const errors = validateRecord('TimelineEvent', fields, {
      confidence: 0.7,
      title: 123,
      active: 'yes',
    });
    expect(errors).toHaveLength(3);
  });
});

describe('createTestData with entity validation', () => {
  it('throws on create when a float is passed to an integer field', async () => {
    const data = createTestData({}, [timelineEventEntity]);
    const repo = data.TimelineEvent ?? unreachable('TimelineEvent repo missing');
    await expect(
      repo.create({
        title: 'Test',
        confidence: 0.7,
        sourceType: 'interview_message',
        createdAt: new Date(),
      }),
    ).rejects.toThrow(/confidence.*expected integer.*got float/i);
  });

  it('allows valid data through', async () => {
    const data = createTestData({}, [timelineEventEntity]);
    const repo = data.TimelineEvent ?? unreachable('TimelineEvent repo missing');
    const record = await repo.create({
      title: 'Test',
      confidence: 5,
      score: 0.7,
      sourceType: 'interview_message',
      createdAt: new Date(),
    });
    expect(record).toBeDefined();
    expect((record as any).id).toBeDefined();
  });

  it('throws on update with invalid data', async () => {
    const data = createTestData(
      { TimelineEvent: [{ id: 'evt-1', title: 'Old', confidence: 3, sourceType: 'interview_message' }] },
      [timelineEventEntity],
    );
    const repo = data.TimelineEvent ?? unreachable('TimelineEvent repo missing');
    await expect(
      repo.update('evt-1', { confidence: 0.5 }),
    ).rejects.toThrow(/confidence.*expected integer/i);
  });

  it('works without entity definitions (backward compat)', async () => {
    const data = createTestData({});
    const repo = data.TimelineEvent ?? unreachable('TimelineEvent repo missing');
    // No validation — float goes through
    const record = await repo.create({ confidence: 0.7 });
    expect(record).toBeDefined();
  });
});

describe('createTestContext with entities option', () => {
  it('validates writes when entities are provided', async () => {
    const ctx = createTestContext({
      entities: [timelineEventEntity],
    });
    const repo = ctx.data.TimelineEvent ?? unreachable('TimelineEvent repo missing');
    await expect(
      repo.create({
        title: 'Test',
        confidence: 0.7,
        sourceType: 'interview_message',
        createdAt: new Date(),
      }),
    ).rejects.toThrow(/confidence.*expected integer.*got float/i);
  });

  it('does not validate writes when entities are not provided', async () => {
    const ctx = createTestContext({});
    const repo = ctx.data.TimelineEvent ?? unreachable('TimelineEvent repo missing');
    const record = await repo.create({ confidence: 0.7 });
    expect(record).toBeDefined();
  });
});
