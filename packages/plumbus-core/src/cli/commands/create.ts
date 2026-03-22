// ── plumbus create <app-name> ──
// Interactive project scaffolding

import type { Command } from 'commander';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { error, exists, info, success, toKebabCase, warn, writeFile } from '../utils.js';

export interface CreateOptions {
  database?: string;
  auth?: string;
  ai?: string;
  compliance?: string;
  git?: boolean;
  skipInstall?: boolean;
  monorepo?: boolean;
}

/** Generate the repository directory structure for a new Plumbus app */
export function generateProjectStructure(
  appName: string,
  options: CreateOptions,
): Map<string, string> {
  if (options.monorepo) {
    return generateMonorepoStructure(appName, options);
  }

  const files = new Map<string, string>();

  // package.json
  files.set(
    'package.json',
    JSON.stringify(
      {
        name: toKebabCase(appName),
        version: '0.1.0',
        type: 'module',
        scripts: {
          dev: 'plumbus dev',
          build: 'tsc -b',
          test: 'vitest run',
          typecheck: 'tsc --noEmit',
          lint: 'biome lint ./app',
          format: 'biome format --write ./app',
          'format:check': 'biome format ./app',
          'migrate:generate': 'plumbus migrate generate',
          'migrate:apply': 'plumbus migrate apply',
          verify: 'plumbus verify',
        },
        dependencies: {
          '@plumbus/core': '^0.1.0',
          zod: '^3.24.0',
        },
        devDependencies: {
          '@biomejs/biome': '^1.9.0',
          typescript: '^5.7.0',
          vitest: '^3.0.0',
          '@types/node': '^22.0.0',
        },
      },
      null,
      2,
    ),
  );

  // tsconfig
  files.set(
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'Node16',
          moduleResolution: 'Node16',
          strict: true,
          esModuleInterop: true,
          outDir: 'dist',
          declaration: true,
          declarationMap: true,
          sourceMap: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          noUncheckedIndexedAccess: true,
        },
        include: ['app', 'config'],
        exclude: ['node_modules', 'dist'],
      },
      null,
      2,
    ),
  );

  // App config
  const complianceArr = options.compliance
    ? options.compliance.split(',').map((c) => `"${c.trim()}"`)
    : [];

  files.set(
    'config/app.config.ts',
    `import type { PlumbusConfig } from "@plumbus/core";

export const config: PlumbusConfig = {
  environment: "development",
  database: {
    host: process.env["DB_HOST"] ?? "localhost",
    port: Number(process.env["DB_PORT"] ?? 5432),
    database: process.env["DB_NAME"] ?? "${toKebabCase(appName)}",
    user: process.env["DB_USER"] ?? "postgres",
    password: process.env["DB_PASSWORD"] ?? "",
  },
  queue: {
    host: process.env["QUEUE_HOST"] ?? "localhost",
    port: Number(process.env["QUEUE_PORT"] ?? 6379),
  },
  auth: {
    provider: "${options.auth ?? 'jwt'}",
  },${options.ai ? `\n  ai: {\n    provider: "${options.ai}",\n    apiKey: process.env["AI_API_KEY"] ?? "",\n  },` : ''}${complianceArr.length > 0 ? `\n  complianceProfiles: [${complianceArr.join(', ')}],` : ''}
};
`,
  );

  // AI config
  files.set(
    'config/ai.config.ts',
    `// AI provider configuration
export const aiConfig = {
  provider: "${options.ai ?? 'openai'}",
  defaultModel: "gpt-4o-mini",
  embeddingModel: "text-embedding-3-small",
};
`,
  );

  // Directory stubs
  files.set('app/capabilities/.gitkeep', '');
  files.set('app/entities/.gitkeep', '');
  files.set('app/flows/.gitkeep', '');
  files.set('app/events/.gitkeep', '');
  files.set('app/prompts/.gitkeep', '');
  files.set('app/compliance/overrides/.gitkeep', '');

  // .gitignore
  files.set(
    '.gitignore',
    `node_modules/
dist/
.plumbus/generated/
.env
*.log
`,
  );

  // biome.json
  files.set(
    'biome.json',
    JSON.stringify(
      {
        $schema: 'https://biomejs.dev/schemas/2.0.0/schema.json',
        linter: {
          enabled: true,
          rules: {
            recommended: true,
          },
        },
        formatter: {
          enabled: true,
          indentStyle: 'space',
          indentWidth: 2,
          lineWidth: 100,
        },
        files: {
          ignore: ['node_modules', 'dist', '.plumbus/generated'],
        },
      },
      null,
      2,
    ),
  );

  // .vscode/settings.json
  files.set(
    '.vscode/settings.json',
    JSON.stringify(
      {
        'editor.defaultFormatter': 'biomejs.biome',
        'editor.formatOnSave': true,
        'editor.codeActionsOnSave': {
          'quickfix.biome': 'explicit',
        },
      },
      null,
      2,
    ),
  );

  // .env.example
  files.set(
    '.env.example',
    `DB_HOST=localhost
DB_PORT=5432
DB_NAME=${toKebabCase(appName)}
DB_USER=postgres
DB_PASSWORD=
QUEUE_HOST=localhost
QUEUE_PORT=6379
AI_API_KEY=
`,
  );

  // README
  files.set(
    'README.md',
    `# ${appName}

Built with [Plumbus Framework](https://github.com/plumbus-framework/plumbus).

## Getting Started

\`\`\`bash
pnpm install
plumbus doctor        # check environment
plumbus migrate apply # run database migrations
plumbus dev           # start development server
\`\`\`

## Project Structure

\`\`\`
app/
  capabilities/   # Business logic (defineCapability)
  entities/       # Data models (defineEntity)
  flows/          # Multi-step workflows (defineFlow)
  events/         # Domain events (defineEvent)
  prompts/        # AI prompts (definePrompt)
config/
  app.config.ts   # Framework configuration
  ai.config.ts    # AI provider configuration
\`\`\`
`,
  );

  return files;
}

/** Generate a pnpm-workspace monorepo with backend, frontend, and shared libs */
function generateMonorepoStructure(appName: string, options: CreateOptions): Map<string, string> {
  const files = new Map<string, string>();
  const kebab = toKebabCase(appName);

  // ── Root workspace files ──

  files.set('pnpm-workspace.yaml', 'packages:\n  - "backend"\n  - "frontend"\n  - "libs/*"\n');

  files.set(
    'package.json',
    JSON.stringify(
      {
        name: kebab,
        version: '0.1.0',
        private: true,
        scripts: {
          dev: `pnpm --filter @${kebab}/backend run dev`,
          build: 'pnpm -r run build',
          test: 'pnpm -r run test',
          typecheck: 'pnpm -r run typecheck',
          lint: 'pnpm -r run lint',
          format: 'pnpm -r run format',
          'format:check': 'pnpm -r run format:check',
        },
      },
      null,
      2,
    ),
  );

  const tsconfigBase = {
    compilerOptions: {
      target: 'ES2022',
      module: 'Node16',
      moduleResolution: 'Node16',
      strict: true,
      esModuleInterop: true,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noUncheckedIndexedAccess: true,
    },
    exclude: ['node_modules', 'dist'],
  };

  files.set('tsconfig.base.json', JSON.stringify(tsconfigBase, null, 2));

  files.set(
    'biome.json',
    JSON.stringify(
      {
        $schema: 'https://biomejs.dev/schemas/2.0.0/schema.json',
        linter: { enabled: true, rules: { recommended: true } },
        formatter: { enabled: true, indentStyle: 'space', indentWidth: 2, lineWidth: 100 },
        files: { ignore: ['node_modules', 'dist', '.plumbus/generated'] },
      },
      null,
      2,
    ),
  );

  files.set(
    '.gitignore',
    `node_modules/
dist/
.plumbus/generated/
.env
*.log
`,
  );

  files.set(
    '.env.example',
    `DB_HOST=localhost
DB_PORT=5432
DB_NAME=${kebab}
DB_USER=postgres
DB_PASSWORD=
QUEUE_HOST=localhost
QUEUE_PORT=6379
AI_API_KEY=
`,
  );

  files.set(
    '.vscode/settings.json',
    JSON.stringify(
      {
        'editor.defaultFormatter': 'biomejs.biome',
        'editor.formatOnSave': true,
        'editor.codeActionsOnSave': { 'quickfix.biome': 'explicit' },
      },
      null,
      2,
    ),
  );

  files.set(
    'README.md',
    `# ${appName}

Built with [Plumbus Framework](https://github.com/plumbus-framework/plumbus).

## Getting Started

\`\`\`bash
pnpm install
plumbus doctor        # check environment
plumbus migrate apply # run database migrations
plumbus dev           # start development server
\`\`\`

## Project Structure

\`\`\`
backend/          # Plumbus application (capabilities, entities, flows, events, prompts)
frontend/         # Next.js frontend (scaffolded via plumbus ui nextjs)
libs/shared/      # Shared type definitions (generated by plumbus generate)
\`\`\`
`,
  );

  // ── Backend package ──

  files.set(
    'backend/package.json',
    JSON.stringify(
      {
        name: `@${kebab}/backend`,
        version: '0.1.0',
        type: 'module',
        scripts: {
          dev: 'plumbus dev',
          build: 'tsc -b',
          test: 'vitest run',
          typecheck: 'tsc --noEmit',
          lint: 'biome lint ./app',
          format: 'biome format --write ./app',
          'format:check': 'biome format ./app',
          'migrate:generate': 'plumbus migrate generate',
          'migrate:apply': 'plumbus migrate apply',
          verify: 'plumbus verify',
        },
        dependencies: {
          '@plumbus/core': '^0.1.0',
          [`@${kebab}/shared`]: 'workspace:*',
          zod: '^3.24.0',
        },
        devDependencies: {
          '@biomejs/biome': '^1.9.0',
          typescript: '^5.7.0',
          vitest: '^3.0.0',
          '@types/node': '^22.0.0',
        },
      },
      null,
      2,
    ),
  );

  files.set(
    'backend/tsconfig.json',
    JSON.stringify(
      {
        extends: '../tsconfig.base.json',
        compilerOptions: { outDir: 'dist' },
        include: ['app', 'config'],
      },
      null,
      2,
    ),
  );

  // App config
  const complianceArr = options.compliance
    ? options.compliance.split(',').map((c) => `"${c.trim()}"`)
    : [];

  files.set(
    'backend/config/app.config.ts',
    `import type { PlumbusConfig } from "@plumbus/core";

export const config: PlumbusConfig = {
  environment: "development",
  database: {
    host: process.env["DB_HOST"] ?? "localhost",
    port: Number(process.env["DB_PORT"] ?? 5432),
    database: process.env["DB_NAME"] ?? "${kebab}",
    user: process.env["DB_USER"] ?? "postgres",
    password: process.env["DB_PASSWORD"] ?? "",
  },
  queue: {
    host: process.env["QUEUE_HOST"] ?? "localhost",
    port: Number(process.env["QUEUE_PORT"] ?? 6379),
  },
  auth: {
    provider: "${options.auth ?? 'jwt'}",
  },${options.ai ? `\n  ai: {\n    provider: "${options.ai}",\n    apiKey: process.env["AI_API_KEY"] ?? "",\n  },` : ''}${complianceArr.length > 0 ? `\n  complianceProfiles: [${complianceArr.join(', ')}],` : ''}
};
`,
  );

  files.set(
    'backend/config/ai.config.ts',
    `// AI provider configuration
export const aiConfig = {
  provider: "${options.ai ?? 'openai'}",
  defaultModel: "gpt-4o-mini",
  embeddingModel: "text-embedding-3-small",
};
`,
  );

  // Backend directory stubs
  files.set('backend/app/capabilities/.gitkeep', '');
  files.set('backend/app/entities/.gitkeep', '');
  files.set('backend/app/flows/.gitkeep', '');
  files.set('backend/app/events/.gitkeep', '');
  files.set('backend/app/prompts/.gitkeep', '');
  files.set('backend/app/compliance/overrides/.gitkeep', '');

  // ── Frontend package ──

  files.set(
    'frontend/package.json',
    JSON.stringify(
      {
        name: `@${kebab}/frontend`,
        version: '0.1.0',
        type: 'module',
        scripts: {
          dev: 'next dev',
          build: 'next build',
          typecheck: 'tsc --noEmit',
          lint: 'biome lint ./app',
          format: 'biome format --write ./app',
          'format:check': 'biome format ./app',
        },
        dependencies: {
          [`@${kebab}/shared`]: 'workspace:*',
        },
        devDependencies: {
          '@biomejs/biome': '^1.9.0',
          typescript: '^5.7.0',
        },
      },
      null,
      2,
    ),
  );

  files.set(
    'frontend/tsconfig.json',
    JSON.stringify(
      {
        extends: '../tsconfig.base.json',
        compilerOptions: { outDir: 'dist' },
        include: ['app', 'lib', 'hooks', 'src'],
      },
      null,
      2,
    ),
  );

  files.set('frontend/src/.gitkeep', '');

  // ── Shared libs package ──

  files.set(
    'libs/shared/package.json',
    JSON.stringify(
      {
        name: `@${kebab}/shared`,
        version: '0.1.0',
        type: 'module',
        main: 'types/index.ts',
        scripts: {
          typecheck: 'tsc --noEmit',
        },
      },
      null,
      2,
    ),
  );

  files.set(
    'libs/shared/tsconfig.json',
    JSON.stringify(
      {
        extends: '../../tsconfig.base.json',
        compilerOptions: { outDir: 'dist' },
        include: ['types'],
      },
      null,
      2,
    ),
  );

  files.set('libs/shared/types/.gitkeep', '');

  return files;
}

export function registerCreateCommand(program: Command): void {
  program
    .command('create <app-name>')
    .description('Create a new Plumbus application')
    .option('--database <type>', 'Database type', 'postgresql')
    .option('--auth <provider>', 'Auth provider', 'jwt')
    .option('--ai <provider>', 'AI provider', 'openai')
    .option('--compliance <profiles>', 'Compliance profiles (comma-separated)')
    .option(
      '--monorepo',
      'Scaffold a pnpm-workspace monorepo with backend, frontend, and shared libs',
    )
    .option('--git', 'Initialize a git repository')
    .option('--skip-install', 'Skip dependency installation')
    .action(async (appName: string, opts: CreateOptions) => {
      const targetDir = path.resolve(process.cwd(), toKebabCase(appName));

      if (exists(targetDir)) {
        error(`Directory "${toKebabCase(appName)}" already exists`);
        process.exit(1);
      }

      info(`Creating Plumbus app: ${appName}`);
      const files = generateProjectStructure(appName, opts);

      for (const [filePath, content] of files) {
        writeFile(path.join(targetDir, filePath), content);
      }

      success(`Project created at ${targetDir}`);

      // Git initialization (only when explicitly requested with --git)
      if (opts.git) {
        try {
          execSync('git init', { cwd: targetDir, stdio: 'pipe' });
          execSync('git add -A', { cwd: targetDir, stdio: 'pipe' });
          execSync('git commit -m "Initial commit from plumbus create"', {
            cwd: targetDir,
            stdio: 'pipe',
          });
          success('Initialized git repository');
        } catch {
          warn('Git initialization failed (git may not be installed)');
        }
      }

      // Dependency installation
      if (!opts.skipInstall) {
        info('Installing dependencies...');
        try {
          execSync('pnpm install', { cwd: targetDir, stdio: 'inherit' });
          success('Dependencies installed');
        } catch {
          warn('Dependency installation failed. Run `pnpm install` manually.');
        }
      }

      info('Run `plumbus init` inside the project to set up AI agent wiring.');
    });
}
