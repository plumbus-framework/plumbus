import type { FieldDescriptor } from "./fields.js";

// ── Entity Retention ──
export interface EntityRetention {
  duration: string;
}

// ── Entity Definition ──
export interface EntityDefinition {
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
