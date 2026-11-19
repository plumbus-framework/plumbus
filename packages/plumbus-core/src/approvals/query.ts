// What an approval request query means, in memory: the memory store answers `findRequests`
// with it, and the service uses it to filter `listRequests()` for a store written before
// `findRequests` existed. The SQL store expresses the same predicate in SQL.

import { PlumbusError } from '../errors/plumbus-error.js';
import { ErrorCode } from '../types/enums.js';
import {
  type ApprovalRequestQuery,
  type ApprovalRequestRecord,
  MAX_APPROVAL_PAGE_SIZE,
} from './types.js';

/** A `limit` / page size must be a whole number from 1 to {@link MAX_APPROVAL_PAGE_SIZE}. */
export function assertApprovalPageSize(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_APPROVAL_PAGE_SIZE) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `${name} must be a whole number from 1 to ${MAX_APPROVAL_PAGE_SIZE} (received ${String(value)})`,
    );
  }
}

function matchesNullable(stored: string | null | undefined, wanted: string | null | undefined) {
  return wanted === undefined || (stored ?? null) === wanted;
}

export function matchesApprovalQuery(
  row: ApprovalRequestRecord,
  query: ApprovalRequestQuery,
): boolean {
  return (
    matchesNullable(row.tenantId, query.tenantId) &&
    matchesNullable(row.executionId, query.executionId) &&
    (query.capabilityId === undefined || row.capabilityId === query.capabilityId) &&
    (query.definitionVersion === undefined || row.definitionVersion === query.definitionVersion) &&
    (query.inputDigest === undefined || row.inputDigest === query.inputDigest) &&
    (query.states === undefined || query.states.includes(row.state))
  );
}

/** Newest first: `createdAt`, then `updatedAt`, then id, all descending. */
export function compareNewestFirst(a: ApprovalRequestRecord, b: ApprovalRequestRecord): number {
  return (
    b.createdAt.localeCompare(a.createdAt) ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    b.approvalRequestId.localeCompare(a.approvalRequestId)
  );
}

/** Filter, order and cut `rows` the way `findRequests` answers `query`. */
export function applyApprovalQuery(
  rows: readonly ApprovalRequestRecord[],
  query: ApprovalRequestQuery,
): ApprovalRequestRecord[] {
  if (query.limit !== undefined) assertApprovalPageSize(query.limit, 'limit');
  const matched = rows.filter((row) => matchesApprovalQuery(row, query)).sort(compareNewestFirst);
  return query.limit === undefined ? matched : matched.slice(0, query.limit);
}
