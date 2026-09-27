import type { FieldClassification, RelationType } from './enums.js';

// ── Base Field Options ──
export interface BaseFieldOptions {
  required?: boolean;
  optional?: boolean;
  default?: unknown;
  unique?: boolean;
  nullable?: boolean;
  classification?: FieldClassification;
  encrypted?: boolean;
  maskedInLogs?: boolean;
}

// ── Specific Field Descriptors ──
export interface IdFieldDescriptor {
  type: 'id';
  options: BaseFieldOptions;
}

export interface StringFieldDescriptor {
  type: 'string';
  options: BaseFieldOptions;
}

export interface NumberFieldDescriptor {
  type: 'number';
  options: BaseFieldOptions;
  /**
   * Column width. Omitted (default) stores a 32-bit PostgreSQL `integer`;
   * `'bigint'` stores a 64-bit `bigint` read back as a JS number (safe integers
   * only). Use `field.bigint()` for money in minor units and running totals.
   */
  size?: 'bigint';
}

export interface DecimalFieldDescriptor {
  type: 'decimal';
  options: BaseFieldOptions;
}

export interface BooleanFieldDescriptor {
  type: 'boolean';
  options: BaseFieldOptions;
}

export interface TimestampFieldDescriptor {
  type: 'timestamp';
  options: BaseFieldOptions;
}

export interface JsonFieldDescriptor {
  type: 'json';
  options: BaseFieldOptions;
}

export interface EnumFieldDescriptor {
  type: 'enum';
  values: readonly string[];
  options: BaseFieldOptions;
}

export interface RelationFieldDescriptor {
  type: 'relation';
  entity: string;
  relationType: RelationType;
  options: BaseFieldOptions;
}

export type FieldDescriptor =
  | IdFieldDescriptor
  | StringFieldDescriptor
  | NumberFieldDescriptor
  | DecimalFieldDescriptor
  | BooleanFieldDescriptor
  | TimestampFieldDescriptor
  | JsonFieldDescriptor
  | EnumFieldDescriptor
  | RelationFieldDescriptor;
