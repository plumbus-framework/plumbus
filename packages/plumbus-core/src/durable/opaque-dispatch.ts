// Opaque spine dispatch records. Privacy by construction: only the allowlisted
// scheduling fields may appear. extra keys (payload, input, auth, …) fail closed.

import { PlumbusError } from '../errors/plumbus-error.js';
import { ErrorCode } from '../types/enums.js';
import {
  OPAQUE_DISPATCH_ALLOWED_KEYS,
  OPAQUE_DISPATCH_FORBIDDEN_KEYS,
  OPAQUE_DISPATCH_REQUIRED_KEYS,
  SpineDeliveryState,
  type OpaqueDispatchRecord,
  type SpineDeliveryState as SpineDeliveryStateType,
} from './types.js';

const DELIVERY_STATES = new Set<string>(Object.values(SpineDeliveryState));

export function spineRecordFromUnknown(value: unknown): OpaqueDispatchRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlumbusError(ErrorCode.Validation, 'opaque dispatch must be an object');
  }
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if ((OPAQUE_DISPATCH_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      throw new PlumbusError(
        ErrorCode.Forbidden,
        `opaque dispatch forbids private field "${key}"`,
        {
          key,
        },
      );
    }
    if (!OPAQUE_DISPATCH_ALLOWED_KEYS.has(key)) {
      throw new PlumbusError(
        ErrorCode.Validation,
        `opaque dispatch rejects additional property "${key}"`,
        { key },
      );
    }
  }

  for (const key of OPAQUE_DISPATCH_REQUIRED_KEYS) {
    if (record[key] === undefined) {
      throw new PlumbusError(
        ErrorCode.Validation,
        `opaque dispatch missing required field "${key}"`,
        {
          key,
        },
      );
    }
  }

  if (record.contractVersion !== '0.1.0') {
    throw new PlumbusError(ErrorCode.Validation, 'opaque dispatch contractVersion must be 0.1.0');
  }
  if (typeof record.expectedRevision !== 'number' || record.expectedRevision < 1) {
    throw new PlumbusError(ErrorCode.Validation, 'opaque dispatch expectedRevision must be >= 1');
  }
  if (typeof record.tenantEpoch !== 'number' || record.tenantEpoch < 1) {
    throw new PlumbusError(ErrorCode.Validation, 'opaque dispatch tenantEpoch must be >= 1');
  }
  if (typeof record.attempt !== 'number' || record.attempt < 0) {
    throw new PlumbusError(ErrorCode.Validation, 'opaque dispatch attempt must be >= 0');
  }
  if (!DELIVERY_STATES.has(String(record.deliveryState))) {
    throw new PlumbusError(ErrorCode.Validation, 'opaque dispatch deliveryState is invalid');
  }

  const deliveryState = record.deliveryState as SpineDeliveryStateType;
  if (deliveryState === SpineDeliveryState.Leased) {
    if (typeof record.leaseRefId !== 'string' || typeof record.leaseExpiresAt !== 'string') {
      throw new PlumbusError(
        ErrorCode.Validation,
        'leased opaque dispatch requires leaseRefId and leaseExpiresAt',
      );
    }
  }
  if (deliveryState === SpineDeliveryState.DeadLettered) {
    if (typeof record.privacySafeFailureCategoryId !== 'string') {
      throw new PlumbusError(
        ErrorCode.Validation,
        'dead-lettered opaque dispatch requires privacySafeFailureCategoryId',
      );
    }
  }

  return record as unknown as OpaqueDispatchRecord;
}

export function assertOpaqueDispatch(value: unknown): asserts value is OpaqueDispatchRecord {
  spineRecordFromUnknown(value);
}

export function createOpaqueDispatchRecord(
  fields: Omit<OpaqueDispatchRecord, 'contractVersion'> & { contractVersion?: '0.1.0' },
): OpaqueDispatchRecord {
  const record: OpaqueDispatchRecord = {
    contractVersion: '0.1.0',
    ...fields,
  };
  return spineRecordFromUnknown(record);
}
