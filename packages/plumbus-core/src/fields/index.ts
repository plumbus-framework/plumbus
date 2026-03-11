// ── Fields Module ──
// Field constructor factory for entity definitions.
// Provides field.string(), field.number(), field.enum(), field.relation(), etc.
//
// Key exports: field (namespace object with typed constructors)

import type { FieldClassification, RelationType } from '../types/enums.js';
import type {
  BaseFieldOptions,
  BooleanFieldDescriptor,
  EnumFieldDescriptor,
  IdFieldDescriptor,
  JsonFieldDescriptor,
  NumberFieldDescriptor,
  RelationFieldDescriptor,
  StringFieldDescriptor,
  TimestampFieldDescriptor,
} from '../types/fields.js';

function opts(o?: BaseFieldOptions): BaseFieldOptions {
  return o ?? {};
}

export const field = {
  id(options?: BaseFieldOptions): IdFieldDescriptor {
    return { type: 'id', options: opts(options) };
  },

  string(options?: BaseFieldOptions): StringFieldDescriptor {
    return { type: 'string', options: opts(options) };
  },

  number(options?: BaseFieldOptions): NumberFieldDescriptor {
    return { type: 'number', options: opts(options) };
  },

  boolean(options?: BaseFieldOptions): BooleanFieldDescriptor {
    return { type: 'boolean', options: opts(options) };
  },

  timestamp(options?: BaseFieldOptions): TimestampFieldDescriptor {
    return { type: 'timestamp', options: opts(options) };
  },

  json(options?: BaseFieldOptions): JsonFieldDescriptor {
    return { type: 'json', options: opts(options) };
  },

  enum(values: readonly string[], options?: BaseFieldOptions): EnumFieldDescriptor {
    if (!values || values.length === 0) {
      throw new Error('Enum field requires at least one value');
    }
    return { type: 'enum', values, options: opts(options) };
  },

  relation(config: {
    entity: string;
    type: RelationType;
    classification?: FieldClassification;
  }): RelationFieldDescriptor {
    if (!config.entity) {
      throw new Error('Relation field requires an entity name');
    }
    return {
      type: 'relation',
      entity: config.entity,
      relationType: config.type,
      options: {
        classification: config.classification,
      },
    };
  },
} as const;
