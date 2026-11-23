import type { FieldDescriptor } from './fields.js';

// ── Entity Retention ──
export interface EntityRetention {
  duration: string;
}

// ── Entity Index Definition ──
/** Options of one index key (`EntityIndexDefinition.columnOptions`). */
export interface EntityIndexColumn {
  order?: 'asc' | 'desc';
  /** Default: PostgreSQL's (`asc` → last, `desc` → first), so `ORDER BY col DESC` uses the index. */
  nulls?: 'first' | 'last';
  /**
   * Operator class, e.g. `gin_trgm_ops` (trigram search; the `pg_trgm` extension must exist,
   * see `plumbus migrate new`) or `jsonb_path_ops`.
   */
  opclass?: string;
}

export interface EntityIndexDefinition {
  /**
   * The index keys, in order: entity fields or framework columns (`id`, `createdAt`,
   * `updatedAt`, `tenantId`). May be empty when `expressions` gives the keys.
   */
  columns: string[];
  /** Per-key options, by column name: sort order, nulls placement, operator class. */
  columnOptions?: Record<string, EntityIndexColumn>;
  /**
   * SQL expressions indexed after `columns`, written with database column names, e.g.
   * `lower(display_name)` or `(metadata->>'kind')`. An index with expressions needs a `name`.
   */
  expressions?: string[];
  unique?: boolean;
  /**
   * Index method. Default `btree`. `gin` on one `field.json()` column without an `opclass`
   * uses `jsonb_path_ops` (serves the repository's `contains` filter). `gist`, `hash` and
   * `brin` are passed through.
   */
  using?: 'btree' | 'gin' | 'gist' | 'hash' | 'brin';
  /** Partial index: an SQL predicate in database column names, e.g. `deleted_at IS NULL`. */
  where?: string;
  /** Index name (default `<table>_<columns>_idx`). Required with `expressions`. */
  name?: string;
}

// ── Entity Definition ──
export interface EntityDefinition {
  name: string;
  description?: string;
  domain?: string;
  tags?: string[];
  owner?: string;

  fields: Record<string, FieldDescriptor>;
  /** Backward compatible: legacy `string[][]` still valid; new entries may declare `unique`. */
  indexes?: Array<string[] | EntityIndexDefinition>;
  retention?: EntityRetention;
  tenantScoped?: boolean;
}
