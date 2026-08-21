import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Shipped tenant durable-core SQL (core_plumbus). Do not apply to application tenant databases. */
export const FRAMEWORK_DURABLE_TENANT_MIGRATIONS = join(
  packageRoot,
  'migrations',
  'durable-tenant',
);

/** Shipped spine opaque_dispatch SQL. Separate database from tenant state. */
export const FRAMEWORK_SPINE_MIGRATIONS = join(packageRoot, 'migrations', 'spine');
