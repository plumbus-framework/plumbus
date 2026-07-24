import type { FieldDescriptor } from './fields.js';

// ── Entity Retention ──
export interface EntityRetention {
  duration: string;
}

// ── Entity Index Definition ──
export interface EntityIndexDefinition {
  columns: string[];
  unique?: boolean;
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
