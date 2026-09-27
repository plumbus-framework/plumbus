// Marks this directory as a Plumbus project for the CLI. Runtime settings come
// from the environment (see .env.example); scripts/e2e.mjs and scripts/dev.mjs set them.
import type { PlumbusConfig } from '@plumbus/core';

export const config: Partial<PlumbusConfig> = {
  environment: 'development',
};
