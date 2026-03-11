// ── Form Generation Hints Generator ──
// Extracts form field metadata from capability input schemas
// so that UI components can consume field names, types, validation rules,
// and required flags for rendering form fields.

import type { CapabilityContract } from "plumbus-core";

// ── Form Metadata Types ──

export type FormFieldType =
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "textarea"
  | "date"
  | "hidden";

export interface FormFieldHint {
  /** Field name / key */
  name: string;
  /** Display label (derived from field name) */
  label: string;
  /** Suggested form input type */
  fieldType: FormFieldType;
  /** Whether the field is required */
  required: boolean;
  /** Default value if any */
  defaultValue?: unknown;
  /** Zod type string for documentation */
  zodType: string;
  /** For enum/select fields — available options */
  options?: string[];
  /** Validation constraints extracted from schema */
  validation: FormValidation;
  /** Field description from .describe() */
  description?: string;
}

export interface FormValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  nullable?: boolean;
}

export interface FormHints {
  /** Capability name */
  capabilityName: string;
  /** Capability kind */
  kind: string;
  /** Form fields in order */
  fields: FormFieldHint[];
}

// ── Helpers ──

function toLabel(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function zodTypeToFieldType(typeName: string): FormFieldType {
  switch (typeName) {
    case "ZodString": return "text";
    case "ZodNumber":
    case "ZodBigInt": return "number";
    case "ZodBoolean": return "boolean";
    case "ZodDate": return "date";
    case "ZodEnum":
    case "ZodNativeEnum": return "select";
    case "ZodObject":
    case "ZodArray":
    case "ZodRecord": return "textarea";
    default: return "text";
  }
}

function getZodTypeName(schema: unknown): string {
  if (schema && typeof schema === "object" && "_def" in schema) {
    const def = (schema as Record<string, unknown>)._def as Record<string, unknown>;
    if (typeof def.typeName === "string") return def.typeName;
  }
  return "ZodUnknown";
}

function extractChecks(schema: unknown): FormValidation {
  const validation: FormValidation = {};
  if (!schema || typeof schema !== "object" || !("_def" in schema)) return validation;

  const def = (schema as Record<string, unknown>)._def as Record<string, unknown>;

  // ZodString/ZodNumber checks
  if (Array.isArray(def.checks)) {
    for (const check of def.checks as Array<Record<string, unknown>>) {
      if (check.kind === "min" && typeof check.value === "number") {
        const typeName = getZodTypeName(schema);
        if (typeName === "ZodString") validation.minLength = check.value;
        else validation.min = check.value;
      }
      if (check.kind === "max" && typeof check.value === "number") {
        const typeName = getZodTypeName(schema);
        if (typeName === "ZodString") validation.maxLength = check.value;
        else validation.max = check.value;
      }
      if (check.kind === "regex" && check.regex instanceof RegExp) {
        validation.pattern = check.regex.source;
      }
      if (check.kind === "email") validation.pattern = "email";
      if (check.kind === "url") validation.pattern = "url";
    }
  }

  // Nullable / optional
  if (def.typeName === "ZodNullable") validation.nullable = true;

  return validation;
}

function unwrapSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || !("_def" in schema)) return schema;
  const def = (schema as Record<string, unknown>)._def as Record<string, unknown>;
  const typeName = def.typeName;

  // Unwrap wrappers to find underlying type
  if (typeName === "ZodOptional" || typeName === "ZodNullable" || typeName === "ZodDefault") {
    return unwrapSchema(def.innerType);
  }
  return schema;
}

function getEnumValues(schema: unknown): string[] | undefined {
  if (!schema || typeof schema !== "object" || !("_def" in schema)) return undefined;
  const def = (schema as Record<string, unknown>)._def as Record<string, unknown>;
  if (def.typeName === "ZodEnum" && Array.isArray(def.values)) {
    return def.values as string[];
  }
  return undefined;
}

function getDefault(schema: unknown): unknown | undefined {
  if (!schema || typeof schema !== "object" || !("_def" in schema)) return undefined;
  const def = (schema as Record<string, unknown>)._def as Record<string, unknown>;
  if (def.typeName === "ZodDefault" && "defaultValue" in def) {
    const fn = def.defaultValue;
    if (typeof fn === "function") {
      try { return fn(); } catch { return undefined; }
    }
    return fn;
  }
  return undefined;
}

function getDescription(schema: unknown): string | undefined {
  if (!schema || typeof schema !== "object" || !("_def" in schema)) return undefined;
  const def = (schema as Record<string, unknown>)._def as Record<string, unknown>;
  return typeof def.description === "string" ? def.description : undefined;
}

function isOptional(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || !("_def" in schema)) return false;
  const def = (schema as Record<string, unknown>)._def as Record<string, unknown>;
  if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault") return true;
  if (def.typeName === "ZodNullable") return isOptional(def.innerType);
  return false;
}

// ── Main Extraction ──

/** Extract form field hints from a single Zod schema field */
export function extractFieldHint(name: string, schema: unknown): FormFieldHint {
  const inner = unwrapSchema(schema);
  const typeName = getZodTypeName(inner);
  const fieldType = zodTypeToFieldType(typeName);

  return {
    name,
    label: toLabel(name),
    fieldType,
    required: !isOptional(schema),
    defaultValue: getDefault(schema),
    zodType: typeName,
    options: getEnumValues(inner),
    validation: {
      ...extractChecks(inner),
      ...(isOptional(schema) ? {} : {}),
      nullable: getZodTypeName(schema) === "ZodNullable" || undefined,
    },
    description: getDescription(schema) ?? getDescription(inner),
  };
}

/** Extract form hints from a capability's input schema */
export function extractFormHints(cap: CapabilityContract): FormHints {
  const fields: FormFieldHint[] = [];

  const schema = cap.input;
  if (schema && typeof schema === "object" && "_def" in schema) {
    const def = (schema as unknown as Record<string, unknown>)._def as Record<string, unknown>;

    // ZodObject — iterate the shape
    if (def.typeName === "ZodObject" && def.shape && typeof def.shape === "function") {
      const shape = (def.shape as () => Record<string, unknown>)();
      for (const [name, fieldSchema] of Object.entries(shape)) {
        fields.push(extractFieldHint(name, fieldSchema));
      }
    }
  }

  return {
    capabilityName: cap.name,
    kind: cap.kind,
    fields,
  };
}

/** Generate a TypeScript form hints constant from a capability */
export function generateFormHintsCode(cap: CapabilityContract): string {
  const hints = extractFormHints(cap);
  const pascal = cap.name.replace(/(^|[-_ ])(\w)/g, (_, _s: string, c: string) => c.toUpperCase());

  return `export const ${pascal}FormHints = ${JSON.stringify(hints, null, 2)} as const;`;
}

/** Generate a module exporting form hints for all capabilities */
export function generateFormHintsModule(capabilities: CapabilityContract[]): string {
  const lines: string[] = [
    "// Auto-generated by @plumbus/ui — do not edit",
    "",
  ];

  for (const cap of capabilities) {
    lines.push(generateFormHintsCode(cap));
    lines.push("");
  }

  return lines.join("\n");
}
