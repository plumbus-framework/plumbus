import {
    jsonb,
    pgTable,
    text,
    timestamp,
    uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle schema for the audit_records table.
 */
export const auditRecords = pgTable("audit_records", {
  id: uuid("id").defaultRandom().primaryKey(),
  actor: text("actor").notNull(),
  tenantId: text("tenant_id"),
  timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
  component: text("component").notNull(),
  action: text("action").notNull(),
  outcome: text("outcome").notNull(), // "success" | "failure" | "denied"
  metadata: jsonb("metadata"),
  maskedFields: jsonb("masked_fields"),
});
