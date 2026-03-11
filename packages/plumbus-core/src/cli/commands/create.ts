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
}

/** Generate the repository directory structure for a new Plumbus app */
export function generateProjectStructure(
  appName: string,
  options: CreateOptions,
): Map<string, string> {
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
          'migrate:generate': 'plumbus migrate generate',
          'migrate:apply': 'plumbus migrate apply',
          verify: 'plumbus verify',
        },
        dependencies: {
          'plumbus-core': '^0.1.0',
          zod: '^3.24.0',
        },
        devDependencies: {
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
          rootDir: 'src',
          declaration: true,
          declarationMap: true,
          sourceMap: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          noUncheckedIndexedAccess: true,
        },
        include: ['src'],
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
    `import type { PlumbusConfig } from "plumbus-core";

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

Built with [Plumbus Framework](https://github.com/plumbus/plumbus).

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

export function registerCreateCommand(program: Command): void {
  program
    .command('create <app-name>')
    .description('Create a new Plumbus application')
    .option('--database <type>', 'Database type', 'postgresql')
    .option('--auth <provider>', 'Auth provider', 'jwt')
    .option('--ai <provider>', 'AI provider', 'openai')
    .option('--compliance <profiles>', 'Compliance profiles (comma-separated)')
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
