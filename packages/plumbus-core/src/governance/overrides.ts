// ── Governance Override System ──
// Developers override governance warnings with structured justifications.
// Overrides are stored as structured data and recorded in governance metadata.

import type { GovernanceOverride, GovernanceSignal } from "../types/governance.js";

// ── Override File Entry (for YAML/JSON storage in app/compliance/overrides/) ──
export interface OverrideEntry {
  rule: string;
  justification: string;
  author: string;
  timestamp: string; // ISO 8601
  scope?: string; // e.g., "entity:User.ssn" or "capability:getUser"
  expiresAt?: string; // ISO 8601 — override expires after this date
}

// ── Override Store ──
export interface OverrideStore {
  getOverrides(): GovernanceOverride[];
  addOverride(entry: OverrideEntry): GovernanceOverride;
  removeOverride(rule: string, scope?: string): boolean;
  hasOverride(rule: string, scope?: string): boolean;
  getExpired(): GovernanceOverride[];
  serialize(): OverrideEntry[];
}

export function createOverrideStore(entries: OverrideEntry[] = []): OverrideStore {
  const overrides: Array<GovernanceOverride & { scope?: string; expiresAt?: Date }> = entries.map(
    (e) => ({
      rule: e.rule,
      justification: e.justification,
      author: e.author,
      timestamp: new Date(e.timestamp),
      scope: e.scope,
      expiresAt: e.expiresAt ? new Date(e.expiresAt) : undefined,
    }),
  );

  return {
    getOverrides() {
      const now = new Date();
      return overrides.filter((o) => !o.expiresAt || o.expiresAt > now);
    },

    addOverride(entry) {
      const override: GovernanceOverride & { scope?: string; expiresAt?: Date } = {
        rule: entry.rule,
        justification: entry.justification,
        author: entry.author,
        timestamp: new Date(entry.timestamp),
        scope: entry.scope,
        expiresAt: entry.expiresAt ? new Date(entry.expiresAt) : undefined,
      };
      overrides.push(override);
      return override;
    },

    removeOverride(rule, scope) {
      const idx = overrides.findIndex((o) => o.rule === rule && o.scope === scope);
      if (idx === -1) return false;
      overrides.splice(idx, 1);
      return true;
    },

    hasOverride(rule, scope) {
      const now = new Date();
      return overrides.some(
        (o) =>
          o.rule === rule &&
          (!scope || o.scope === scope || !o.scope) &&
          (!o.expiresAt || o.expiresAt > now),
      );
    },

    getExpired() {
      const now = new Date();
      return overrides.filter((o) => o.expiresAt && o.expiresAt <= now);
    },

    serialize() {
      return overrides.map((o) => ({
        rule: o.rule,
        justification: o.justification,
        author: o.author,
        timestamp: o.timestamp.toISOString(),
        scope: o.scope,
        expiresAt: o.expiresAt?.toISOString(),
      }));
    },
  };
}

/** Filter governance signals by applying overrides — returns only non-overridden signals */
export function applyOverrides(
  signals: GovernanceSignal[],
  overrides: GovernanceOverride[],
): { effective: GovernanceSignal[]; overridden: GovernanceSignal[] } {
  const overrideRules = new Set(overrides.map((o) => o.rule));
  const effective: GovernanceSignal[] = [];
  const overridden: GovernanceSignal[] = [];
  for (const signal of signals) {
    if (overrideRules.has(signal.rule)) {
      overridden.push(signal);
    } else {
      effective.push(signal);
    }
  }
  return { effective, overridden };
}
