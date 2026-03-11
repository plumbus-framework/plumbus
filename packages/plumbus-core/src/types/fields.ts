import type { FieldClassification, RelationType } from './enums.js';

// ── Base Field Options ──
export interface BaseFieldOptions {
  required?: boolean;
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
  | BooleanFieldDescriptor
  | TimestampFieldDescriptor
  | JsonFieldDescriptor
  | EnumFieldDescriptor
  | RelationFieldDescriptor;
