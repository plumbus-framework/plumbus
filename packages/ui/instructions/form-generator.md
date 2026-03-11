# Form Generator

Extracts form field metadata from Zod schemas attached to capability contracts. Produces structured hints that UI components can consume for rendering form fields with labels, input types, validation, and options.

## Types

```ts
type FormFieldType = "text" | "number" | "boolean" | "select" | "textarea" | "date" | "hidden";

interface FormFieldHint {
  name: string;            // Field key from the schema
  label: string;           // Human-readable label (auto-derived)
  fieldType: FormFieldType; // Suggested HTML input type
  required: boolean;        // true unless ZodOptional or ZodDefault
  defaultValue?: unknown;   // From .default() if set
  zodType: string;          // Underlying Zod type name (e.g. "ZodString")
  options?: string[];       // For ZodEnum — the allowed values
  validation: FormValidation;
  description?: string;     // From .describe() if set
}

interface FormValidation {
  min?: number;         // ZodNumber .min()
  max?: number;         // ZodNumber .max()
  minLength?: number;   // ZodString .min()
  maxLength?: number;   // ZodString .max()
  pattern?: string;     // ZodString .regex() source, or "email"/"url"
  nullable?: boolean;   // ZodNullable wrapper
}

interface FormHints {
  capabilityName: string;
  kind: string;
  fields: FormFieldHint[];
}
```

## How It Works

The form generator introspects Zod schemas at runtime via their `_def` property. It does **not** use `z.infer` or code generation — it reads the schema tree directly.

### Schema Unwrapping

Wrapper types are unwrapped to find the underlying type:
- `ZodOptional` → unwrap `innerType`, mark `required: false`
- `ZodNullable` → unwrap `innerType`, set `validation.nullable: true`
- `ZodDefault` → unwrap `innerType`, mark `required: false`, extract default value

### Zod Type → Form Field Type Mapping

| Zod Type | Form Field Type |
|----------|----------------|
| ZodString | `"text"` |
| ZodNumber, ZodBigInt | `"number"` |
| ZodBoolean | `"boolean"` |
| ZodDate | `"date"` |
| ZodEnum, ZodNativeEnum | `"select"` |
| ZodObject, ZodArray, ZodRecord | `"textarea"` |
| Other | `"text"` |

### Validation Extraction

Checks are read from `_def.checks` array:

| Check Kind | Extracted As |
|------------|-------------|
| `min` (ZodString) | `minLength` |
| `max` (ZodString) | `maxLength` |
| `min` (ZodNumber) | `min` |
| `max` (ZodNumber) | `max` |
| `regex` | `pattern` (regex source) |
| `email` | `pattern: "email"` |
| `url` | `pattern: "url"` |

### Label Generation

Field names are converted to title case: `firstName` → `"First Name"`, `user_email` → `"User Email"`.

## Functions

### `extractFieldHint(name, schema)`

Extract metadata for a single Zod field:

```ts
import { z } from "zod";
import { extractFieldHint } from "@plumbus/ui";

const hint = extractFieldHint("email", z.string().email().describe("User's email"));
// → { name: "email", label: "Email", fieldType: "text", required: true,
//     zodType: "ZodString", validation: { pattern: "email" }, description: "User's email" }
```

### `extractFormHints(cap)`

Extract hints for all fields in a capability's `input` schema (must be `ZodObject`):

```ts
const hints = extractFormHints(createUserCapability);
// → { capabilityName: "createUser", kind: "action", fields: [...] }
```

Iterates over the `ZodObject` shape via `_def.shape()`.

### `generateFormHintsCode(cap)`

Produce a TypeScript constant with the extracted hints:

```ts
generateFormHintsCode(cap)
// → export const CreateUserFormHints = { ... } as const;
```

### `generateFormHintsModule(capabilities)`

Produce a module exporting form hints for all capabilities:

```ts
const code = generateFormHintsModule([createUser, updateUser]);
// Write to: generated/form-hints.ts
```

## Usage Pattern

```ts
// 1. Extract hints at build time
const hints = extractFormHints(createUserCapability);

// 2. Use hints in a React component
function DynamicForm({ hints }: { hints: FormHints }) {
  return (
    <form>
      {hints.fields.map((field) => (
        <div key={field.name}>
          <label>{field.label}</label>
          {field.fieldType === "select" ? (
            <select name={field.name} required={field.required}>
              {field.options?.map((opt) => <option key={opt}>{opt}</option>)}
            </select>
          ) : (
            <input
              name={field.name}
              type={field.fieldType}
              required={field.required}
              minLength={field.validation.minLength}
              maxLength={field.validation.maxLength}
              min={field.validation.min}
              max={field.validation.max}
              defaultValue={field.defaultValue as string}
            />
          )}
        </div>
      ))}
    </form>
  );
}
```
