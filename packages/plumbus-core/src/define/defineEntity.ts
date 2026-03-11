import type { EntityDefinition, EntityRetention } from "../types/entity.js";
import type { FieldDescriptor } from "../types/fields.js";

interface DefineEntityInput {
  name: string;
  description?: string;
  domain?: string;
  tags?: string[];
  owner?: string;

  fields: Record<string, FieldDescriptor>;
  indexes?: string[][];
  retention?: EntityRetention;
  tenantScoped?: boolean;
}

export function defineEntity(config: DefineEntityInput): EntityDefinition {
  if (!config.name) {
    throw new Error("Entity name is required");
  }
  if (!config.fields || Object.keys(config.fields).length === 0) {
    throw new Error(`Entity "${config.name}": at least one field is required`);
  }

  // Validate indexes reference existing fields
  if (config.indexes) {
    const fieldNames = new Set(Object.keys(config.fields));
    for (const idx of config.indexes) {
      for (const col of idx) {
        if (!fieldNames.has(col)) {
          throw new Error(
            `Entity "${config.name}": index references unknown field "${col}"`,
          );
        }
      }
    }
  }

  return Object.freeze({ ...config });
}
