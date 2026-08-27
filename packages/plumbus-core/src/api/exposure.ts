import type { CapabilityContract } from '../types/capability.js';

/** True when the capability is exposed as an external API operation (`exposeAs: ['api']`). */
export function isApiExposed(cap: CapabilityContract): boolean {
  return cap.exposeAs?.includes('api') ?? false;
}

/**
 * The HTTP method a capability's route and client use.
 *
 * A capability's `kind` says what it *does* — a query reads, an action writes — and that is a
 * good default for the verb. It is only a default. Where a capability declares `api.method`, the
 * declaration wins, because the method also decides where the input travels: a GET carries it in
 * the query string, and a query string is kept by access logs, proxies and referrers in a way a
 * body is not. `resolve-account-by-identity` is the case that forced this — a read whose input is
 * a person's verified address, declared `POST` for exactly that reason and served as `GET`
 * anyway, putting the address in the request line of every call.
 *
 * So: honour what the contract says, and fall back to the kind only when it says nothing.
 */
export function capabilityHttpMethod(cap: CapabilityContract): string {
  return cap.api?.method ?? (cap.kind === 'query' ? 'GET' : 'POST');
}
