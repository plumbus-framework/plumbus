// ── Credential catalog ──
// Named credential *types* a host declares. The catalog holds type shapes and
// opaque bindings (name + ref). It does not mint IAM, store secrets, or ship
// built-in types. The host supplies field values at reveal time; secret fields
// never appear in describe(), JSON, inspect, or error text.

import { inspect } from 'node:util';
import { PlumbusError } from '../errors/plumbus-error.js';
import { ErrorCode } from '../types/enums.js';

/** What a scrubbed secret is replaced with wherever one could have appeared. */
export const CREDENTIAL_REDACTED = '[redacted]';

const TYPE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const FIELD_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const BINDING_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/=#@-]{0,255}$/;
const LABEL_VALUE_MAX = 256;

export class CredentialCatalogError extends PlumbusError {
  constructor(code: ErrorCode, message: string, metadata?: Record<string, unknown>) {
    super(code, message, metadata);
    this.name = 'CredentialCatalogError';
  }
}

export interface CredentialFieldSpec {
  name: string;
  /** Secret fields are omitted from describe/JSON/inspect and read via `secret()`. */
  secret: boolean;
}

export interface CredentialTypeDeclaration {
  /** Host-chosen type id (`smtp`, `object-storage`, …). Not a built-in list. */
  id: string;
  fields: readonly CredentialFieldSpec[];
}

export interface CredentialTypeRecord {
  id: string;
  fields: readonly CredentialFieldSpec[];
}

export interface CredentialBinding {
  name: string;
  typeId: string;
  /** Opaque reference the host stores. Never a secret value. */
  ref: string;
  /** Public labels only. Names of secret fields are refused. */
  labels?: Record<string, string>;
}

export interface CredentialRecord {
  name: string;
  typeId: string;
  ref: string;
  labels: Readonly<Record<string, string>>;
}

/**
 * Revealed material. `fields` holds non-secret values only. Secret values are
 * read with `secret(fieldName)` so a log of the object or a spread of `fields`
 * cannot leak them.
 */
export interface CredentialMaterial {
  readonly typeId: string;
  readonly name: string;
  readonly ref: string;
  readonly fields: Readonly<Record<string, string>>;
  secret(fieldName: string): string;
}

export type CredentialResolver = (
  record: CredentialRecord,
) => Promise<Record<string, string>> | Record<string, string>;

export interface CredentialCatalog {
  listTypes(): readonly CredentialTypeRecord[];
  getType(typeId: string): CredentialTypeRecord | undefined;
  bind(binding: CredentialBinding): CredentialRecord;
  get(name: string): CredentialRecord | undefined;
  getByRef(ref: string): CredentialRecord | undefined;
  list(): readonly CredentialRecord[];
  reveal(name: string): Promise<CredentialMaterial>;
}

export interface MemoryCredentialCatalogOptions {
  types: readonly CredentialTypeDeclaration[];
  /**
   * Host lookup of field values for a bound ref. Omitted: `reveal` refuses.
   * The catalog never stores the returned values.
   */
  resolve?: CredentialResolver;
}

function catalogError(
  code: ErrorCode,
  message: string,
  metadata?: Record<string, unknown>,
): CredentialCatalogError {
  return new CredentialCatalogError(code, message, metadata);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function assertPattern(value: string, pattern: RegExp, field: string): string {
  if (!pattern.test(value)) {
    throw catalogError(ErrorCode.Validation, `${field} is not a valid catalog identifier`, {
      field,
    });
  }
  return value;
}

function freezeType(type: CredentialTypeRecord): CredentialTypeRecord {
  return Object.freeze({
    id: type.id,
    fields: Object.freeze(type.fields.map((field) => Object.freeze({ ...field }))),
  });
}

function freezeRecord(record: CredentialRecord): CredentialRecord {
  return Object.freeze({
    name: record.name,
    typeId: record.typeId,
    ref: record.ref,
    labels: Object.freeze({ ...record.labels }),
  });
}

function normalizeTypes(
  types: readonly CredentialTypeDeclaration[],
): Map<string, CredentialTypeRecord> {
  if (!Array.isArray(types)) {
    throw catalogError(ErrorCode.Validation, 'types must be an array', { field: 'types' });
  }
  const byId = new Map<string, CredentialTypeRecord>();
  for (const declared of types) {
    if (declared === null || typeof declared !== 'object') {
      throw catalogError(ErrorCode.Validation, 'each type must be an object', { field: 'types' });
    }
    const id = assertPattern(declared.id, TYPE_ID_PATTERN, 'type id');
    if (byId.has(id)) {
      throw catalogError(ErrorCode.Conflict, `credential type "${id}" is already declared`, {
        typeId: id,
      });
    }
    if (!Array.isArray(declared.fields) || declared.fields.length === 0) {
      throw catalogError(
        ErrorCode.Validation,
        `credential type "${id}" must declare at least one field`,
        {
          typeId: id,
          field: 'fields',
        },
      );
    }
    const fieldNames = new Set<string>();
    const fields: CredentialFieldSpec[] = [];
    for (const field of declared.fields) {
      if (field === null || typeof field !== 'object') {
        throw catalogError(ErrorCode.Validation, `credential type "${id}" has an invalid field`, {
          typeId: id,
        });
      }
      const name = assertPattern(field.name, FIELD_NAME_PATTERN, 'field name');
      if (fieldNames.has(name)) {
        throw catalogError(ErrorCode.Conflict, `credential type "${id}" repeats field "${name}"`, {
          typeId: id,
          field: name,
        });
      }
      if (typeof field.secret !== 'boolean') {
        throw catalogError(
          ErrorCode.Validation,
          `field "${name}" on type "${id}" must set secret`,
          {
            typeId: id,
            field: name,
          },
        );
      }
      fieldNames.add(name);
      fields.push({ name, secret: field.secret });
    }
    byId.set(id, freezeType({ id, fields }));
  }
  return byId;
}

function normalizeLabels(
  labels: Record<string, string> | undefined,
  secretFields: ReadonlySet<string>,
): Record<string, string> {
  if (labels === undefined) return {};
  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) {
    throw catalogError(ErrorCode.Validation, 'labels must be a string map', { field: 'labels' });
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    assertPattern(key, FIELD_NAME_PATTERN, 'label key');
    if (secretFields.has(key)) {
      throw catalogError(
        ErrorCode.Validation,
        `label "${key}" names a secret field and cannot be stored on the binding`,
        { field: 'labels', label: key },
      );
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > LABEL_VALUE_MAX) {
      throw catalogError(ErrorCode.Validation, `label "${key}" must be a non-empty string`, {
        field: 'labels',
        label: key,
      });
    }
    if (hasControlCharacter(value)) {
      throw catalogError(
        ErrorCode.Validation,
        `label "${key}" must not contain control characters`,
        {
          field: 'labels',
          label: key,
        },
      );
    }
    normalized[key] = value;
  }
  return normalized;
}

function publicView(record: CredentialRecord, fields: Readonly<Record<string, string>>): object {
  return {
    typeId: record.typeId,
    name: record.name,
    ref: record.ref,
    fields: { ...fields },
  };
}

function wrapMaterial(
  record: CredentialRecord,
  publicFields: Record<string, string>,
  secrets: Record<string, string>,
): CredentialMaterial {
  const frozenPublic = Object.freeze({ ...publicFields });
  const frozenSecrets = Object.freeze({ ...secrets });

  const material = {
    typeId: record.typeId,
    name: record.name,
    ref: record.ref,
    fields: frozenPublic,
  } as CredentialMaterial;

  Object.defineProperty(material, 'secret', {
    enumerable: false,
    value(fieldName: string) {
      if (Object.hasOwn(frozenPublic, fieldName)) {
        throw catalogError(
          ErrorCode.Validation,
          `field "${fieldName}" on credential "${record.name}" is not secret`,
          { name: record.name, field: fieldName },
        );
      }
      if (!Object.hasOwn(frozenSecrets, fieldName)) {
        throw catalogError(
          ErrorCode.NotFound,
          `credential "${record.name}" has no secret field "${fieldName}"`,
          { name: record.name, field: fieldName },
        );
      }
      return frozenSecrets[fieldName]!;
    },
  });
  Object.defineProperty(material, 'toJSON', {
    value: () => publicView(record, frozenPublic),
    enumerable: false,
  });
  Object.defineProperty(material, 'toString', {
    value: () => `CredentialMaterial(${record.typeId} ${record.name})`,
    enumerable: false,
  });
  Object.defineProperty(material, inspect.custom, {
    value: () => publicView(record, frozenPublic),
    enumerable: false,
  });

  return Object.freeze(material);
}

function splitResolvedFields(
  type: CredentialTypeRecord,
  record: CredentialRecord,
  resolved: Record<string, string>,
): { publicFields: Record<string, string>; secrets: Record<string, string> } {
  if (resolved === null || typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw catalogError(
      ErrorCode.Validation,
      `resolver for credential "${record.name}" must return a field map`,
      { name: record.name, typeId: record.typeId },
    );
  }

  const declared = new Map(type.fields.map((field) => [field.name, field.secret]));
  const extra = Object.keys(resolved).filter((name) => !declared.has(name));
  if (extra.length > 0) {
    throw catalogError(
      ErrorCode.Validation,
      `resolver for credential "${record.name}" returned unknown fields`,
      { name: record.name, typeId: record.typeId, fields: extra },
    );
  }

  const publicFields: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of type.fields) {
    const value = resolved[field.name];
    if (typeof value !== 'string' || value.length === 0) {
      throw catalogError(
        ErrorCode.Validation,
        `resolver for credential "${record.name}" omitted field "${field.name}"`,
        { name: record.name, typeId: record.typeId, field: field.name },
      );
    }
    if (hasControlCharacter(value) && !field.secret) {
      throw catalogError(
        ErrorCode.Validation,
        `field "${field.name}" on credential "${record.name}" must not contain control characters`,
        { name: record.name, field: field.name },
      );
    }
    if (field.secret) {
      secrets[field.name] = value;
    } else {
      publicFields[field.name] = value;
    }
  }
  return { publicFields, secrets };
}

/**
 * In-memory catalog of host-declared credential types and opaque bindings.
 * No built-in types. Secrets live in the host resolver, not in the catalog.
 */
export function createMemoryCredentialCatalog(
  options: MemoryCredentialCatalogOptions,
): CredentialCatalog {
  if (options === null || typeof options !== 'object') {
    throw catalogError(ErrorCode.Validation, 'catalog options are required', { field: 'options' });
  }
  const types = normalizeTypes(options.types);
  const byName = new Map<string, CredentialRecord>();
  const byRef = new Map<string, CredentialRecord>();
  const resolve = options.resolve;

  return {
    listTypes() {
      return [...types.values()];
    },
    getType(typeId) {
      return types.get(typeId);
    },
    bind(binding) {
      if (binding === null || typeof binding !== 'object') {
        throw catalogError(ErrorCode.Validation, 'binding must be an object', { field: 'binding' });
      }
      const name = assertPattern(binding.name, BINDING_NAME_PATTERN, 'binding name');
      const typeId = assertPattern(binding.typeId, TYPE_ID_PATTERN, 'type id');
      const type = types.get(typeId);
      if (!type) {
        throw catalogError(ErrorCode.NotFound, `credential type "${typeId}" is not declared`, {
          typeId,
        });
      }
      if (typeof binding.ref !== 'string' || !REF_PATTERN.test(binding.ref)) {
        throw catalogError(ErrorCode.Validation, 'binding ref is not a valid opaque reference', {
          field: 'ref',
        });
      }
      if (byName.has(name)) {
        throw catalogError(ErrorCode.Conflict, `credential "${name}" is already bound`, { name });
      }
      if (byRef.has(binding.ref)) {
        throw catalogError(ErrorCode.Conflict, 'binding ref is already in use', { field: 'ref' });
      }
      const secretFields = new Set(
        type.fields.filter((field) => field.secret).map((field) => field.name),
      );
      const record = freezeRecord({
        name,
        typeId,
        ref: binding.ref,
        labels: normalizeLabels(binding.labels, secretFields),
      });
      byName.set(name, record);
      byRef.set(record.ref, record);
      return record;
    },
    get(name) {
      return byName.get(name);
    },
    getByRef(ref) {
      return byRef.get(ref);
    },
    list() {
      return [...byName.values()];
    },
    async reveal(name) {
      const record = byName.get(name);
      if (!record) {
        throw catalogError(ErrorCode.NotFound, `credential "${name}" is not bound`, { name });
      }
      if (!resolve) {
        throw catalogError(
          ErrorCode.Internal,
          `credential catalog has no resolver for "${record.name}"`,
          { name: record.name, typeId: record.typeId },
        );
      }
      const type = types.get(record.typeId);
      if (!type) {
        throw catalogError(ErrorCode.Internal, `credential type "${record.typeId}" is missing`, {
          typeId: record.typeId,
        });
      }

      let resolved: Record<string, string>;
      try {
        resolved = await resolve(record);
      } catch {
        // Host errors are not re-thrown: their text may contain the secret.
        throw catalogError(
          ErrorCode.Internal,
          `Could not resolve credential "${record.name}" of type "${record.typeId}"`,
          { name: record.name, typeId: record.typeId, ref: record.ref },
        );
      }

      const { publicFields, secrets } = splitResolvedFields(type, record, resolved);
      return wrapMaterial(record, publicFields, secrets);
    },
  };
}
