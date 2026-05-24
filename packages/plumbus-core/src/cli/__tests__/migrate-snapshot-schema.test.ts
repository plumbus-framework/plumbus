import { describe, expect, it } from 'vitest';
import { DrizzleSnapshotSchema, parseDrizzleSnapshot } from '../migrate-snapshot-schema.js';

describe('parseDrizzleSnapshot', () => {
  it('parses a minimal valid snapshot', () => {
    const raw = JSON.stringify({ id: 'abc-123', prevId: null });
    const snapshot = parseDrizzleSnapshot(raw, 'meta/0000_snapshot.json');
    expect(snapshot.id).toBe('abc-123');
    expect(snapshot.prevId).toBeNull();
  });

  it('allows extra Drizzle fields via passthrough', () => {
    const raw = JSON.stringify({
      id: 'snap-1',
      prevId: 'snap-0',
      dialect: 'postgresql',
      tables: {},
    });
    const snapshot = parseDrizzleSnapshot(raw, 'meta/0001_snapshot.json');
    expect(snapshot.id).toBe('snap-1');
    expect((snapshot as { dialect?: string }).dialect).toBe('postgresql');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseDrizzleSnapshot('{not json', 'broken.json')).toThrow(
      'Invalid JSON in migration snapshot broken.json',
    );
  });

  it('rejects snapshots missing required id', () => {
    const raw = JSON.stringify({ prevId: null });
    expect(() => parseDrizzleSnapshot(raw, 'meta/bad.json')).toThrow(
      'Invalid migration snapshot meta/bad.json',
    );
  });

  it('validates with DrizzleSnapshotSchema directly', () => {
    const result = DrizzleSnapshotSchema.safeParse({ id: 'x' });
    expect(result.success).toBe(true);
  });
});
