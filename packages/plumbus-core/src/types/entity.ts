import type { FieldDescriptor } from './fields.js';

// ── Entity Retention ──
export interface EntityRetention {
  duration: string;
}

// ── Entity Index Definition ──
export interface EntityIndexDefinition {
  columns: string[];
  unique?: boolean;
  /**
   * Index method. Default `btree`. `gin` indexes one `field.json()` column with the
   * `jsonb_path_ops` operator class, which serves the repository's `contains` filter
   * (`col @> value`); a gin index cannot be `unique`.
   */
  using?: 'btree' | 'gin';
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
