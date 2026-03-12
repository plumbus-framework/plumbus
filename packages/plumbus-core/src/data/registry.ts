import type { PgTableWithColumns } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AuditService } from '../types/audit.js';
import type { DataService, Repository } from '../types/context.js';
import type { EntityDefinition } from '../types/entity.js';
import type { AuthContext } from '../types/security.js';
import { createRepository } from './repository.js';
import { generateDrizzleSchema } from './schema-generator.js';

/**
 * EntityRegistry holds all registered entities, their Drizzle schemas,
 * and constructs data services (per-request Repository instances)
 * scoped to the caller's auth context.
 */
export class EntityRegistry {
  private entities = new Map<string, EntityDefinition>();
  private tables = new Map<string, PgTableWithColumns<any>>();

  /**
   * Register an entity definition. Generates and caches its Drizzle schema.
   */
  register(entity: EntityDefinition): void {
    if (this.entities.has(entity.name)) {
      throw new Error(`Entity "${entity.name}" is already registered`);
    }
    this.entities.set(entity.name, entity);
    this.tables.set(entity.name, generateDrizzleSchema(entity));
  }

  /**
   * Register multiple entities at once.
   */
  registerAll(entities: EntityDefinition[]): void {
    for (const entity of entities) {
      this.register(entity);
    }
  }

  /**
   * Get a registered entity definition by name.
   */
  getEntity(name: string): EntityDefinition | undefined {
    return this.entities.get(name);
  }

  /**
   * Get the Drizzle table for a registered entity.
   */
  getTable(name: string): PgTableWithColumns<any> | undefined {
    return this.tables.get(name);
  }

  /**
   * Get all registered entity definitions.
   */
  getAllEntities(): EntityDefinition[] {
    return Array.from(this.entities.values());
  }

  /**
   * Get all Drizzle table schemas (for migration generation).
   */
  getAllTables(): Record<string, PgTableWithColumns<any>> {
    return Object.fromEntries(this.tables);
  }

  /**
   * Build a DataService — a record of repositories keyed by entity name,
   * each scoped to the given auth context for tenant isolation and audit.
   */
  createDataService(options: {
    db: PostgresJsDatabase;
    auth: AuthContext;
    audit?: AuditService;
  }): DataService {
    const dataService: Record<string, Repository> = {};

    for (const [name, entity] of this.entities) {
      const table = this.tables.get(name);
      if (!table) continue;
      dataService[name] = createRepository({
        entity,
        table,
        db: options.db,
        auth: options.auth,
        audit: options.audit,
      });
    }

    return dataService;
  }
}
