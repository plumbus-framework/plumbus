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
  /**
   * An update that changes only fields marked `auditSilent` writes no audit record. For
   * operational stamps — a session's `lastSeenAt`, a heartbeat — that a request touches every
   * time it runs; auditing them buries every real mutation under one row per request. Creates,
   * deletes and updates that touch any other field are audited as before.
   */
  auditSilent?: boolean;
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
