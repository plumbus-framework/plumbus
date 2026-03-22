// ── Plumbus Type Registry ──
// Empty by default. Consumer apps augment this interface via `plumbus generate`,
// which produces a `.plumbus/generated/plumbus.d.ts` file containing:
//
//   declare module "@plumbus/core" {
//     interface PlumbusRegistry {
//       capabilityName: "getInvoice" | "createOrder";
//       eventName: "user.created" | "order.completed";
//       flowName: "onboardUser" | "processOrder";
//       entities: { User: Repository<UserRecord>; Order: Repository<OrderRecord> };
//     }
//   }
//
// Until generation runs, all derived types fall back to `string` (for names)
// or a permissive index signature (for entities), preserving backward compatibility.

import type { Repository } from './context.js';

// biome-ignore lint/suspicious/noEmptyInterface: augmented by consumer apps via plumbus generate
export interface PlumbusRegistry {}

// ── Derived Types ──
// These conditional types read from the registry when populated, otherwise
// fall back to permissive defaults so existing code continues to compile.

export type RegisteredCapabilityName = PlumbusRegistry extends {
  capabilityName: infer C extends string;
}
  ? C
  : string;

export type RegisteredEventName = PlumbusRegistry extends {
  eventName: infer E extends string;
}
  ? E
  : string;

export type RegisteredFlowName = PlumbusRegistry extends {
  flowName: infer F extends string;
}
  ? F
  : string;

export type RegisteredEntities = PlumbusRegistry extends {
  entities: infer E extends Record<string, Repository>;
}
  ? E
  : Record<string, Repository>;
