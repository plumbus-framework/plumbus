import { IDENTIFIER_MAX_BYTES, USER_ID_MAX_BYTES } from '../config/constants.js';
import type {
  AuthorizationResolution,
  IdentityResolution,
  ResolveAuthorization,
  ResolveIdentity,
} from './types.js';

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('resolver_timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function normalizeStringList(values: unknown, maxCount: number, label: string): string[] {
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array`);
  }
  if (values.length > maxCount) {
    throw new Error(`${label} exceeds configured maximum`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    if (typeof entry !== 'string') {
      throw new Error(`${label} entries must be strings`);
    }
    const trimmed = entry.trim();
    if (byteLength(trimmed) > IDENTIFIER_MAX_BYTES) {
      throw new Error(`${label} entry exceeds maximum byte length`);
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

export async function executeResolveIdentity(
  resolve: ResolveIdentity,
  input: Parameters<ResolveIdentity>[0],
  timeoutMs: number,
): Promise<IdentityResolution | { status: 'temporary' }> {
  try {
    const result = await withTimeout(resolve(input), timeoutMs);
    if (result.status === 'admitted') {
      if (!result.userId || byteLength(result.userId) > USER_ID_MAX_BYTES) {
        throw new Error('invalid userId');
      }
      return result;
    }
    if (result.status === 'denied') {
      return result;
    }
    throw new Error('malformed identity resolution');
  } catch (error) {
    if (error instanceof Error && error.message === 'resolver_timeout') {
      return { status: 'temporary' };
    }
    if (error instanceof Error && error.message === 'invalid userId') {
      return { status: 'denied' };
    }
    return { status: 'temporary' };
  }
}

export async function executeResolveAuthorization(
  resolve: ResolveAuthorization,
  input: Parameters<ResolveAuthorization>[0],
  timeoutMs: number,
  limits: { maxRoles: number; maxScopes: number },
): Promise<AuthorizationResolution | { status: 'temporary' }> {
  try {
    const result = await withTimeout(resolve(input), timeoutMs);
    if (result.status === 'revoked') {
      return result;
    }
    if (result.status !== 'authorized') {
      throw new Error('malformed authorization resolution');
    }
    const roles = normalizeStringList(result.roles, limits.maxRoles, 'roles');
    const scopes = normalizeStringList(result.scopes, limits.maxScopes, 'scopes');
    let tenantId: string | undefined;
    if (result.tenantId !== undefined) {
      if (
        typeof result.tenantId !== 'string' ||
        byteLength(result.tenantId) > IDENTIFIER_MAX_BYTES
      ) {
        throw new Error('invalid tenantId');
      }
      tenantId = result.tenantId.trim();
    }
    return { status: 'authorized', roles, scopes, tenantId };
  } catch (error) {
    if (error instanceof Error && error.message === 'resolver_timeout') {
      return { status: 'temporary' };
    }
    return { status: 'temporary' };
  }
}
