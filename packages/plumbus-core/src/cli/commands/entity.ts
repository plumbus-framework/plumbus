// ── plumbus entity new ──
// Scaffold a new entity

import type { Command } from 'commander';
import { entityTemplate } from '../templates/resources.js';
import { error, exists, resolvePath, success, toKebabCase, writeFile } from '../utils.js';

export function registerEntityCommand(program: Command): void {
  const cmd = program.command('entity').description('Manage entities');

  cmd
    .command('new <name>')
    .description('Scaffold a new entity')
    .action((name: string) => {
      const kebab = toKebabCase(name);
      const filePath = resolvePath('app', 'entities', `${kebab}.entity.ts`);

      if (exists(filePath)) {
        error(`Entity "${kebab}" already exists`);
        process.exit(1);
      }

      writeFile(filePath, entityTemplate(name));
      success(`Created entity: app/entities/${kebab}.entity.ts`);
    });
}
