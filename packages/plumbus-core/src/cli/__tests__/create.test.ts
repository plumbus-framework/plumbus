import { describe, expect, it } from 'vitest';
import { type CreateOptions, generateProjectStructure } from '../commands/create.js';

describe('plumbus create', () => {
  it('generates standard project files', () => {
    const files = generateProjectStructure('MyApp', {});
    expect(files.has('package.json')).toBe(true);
    expect(files.has('tsconfig.json')).toBe(true);
    expect(files.has('config/app.config.ts')).toBe(true);
    expect(files.has('config/ai.config.ts')).toBe(true);
    expect(files.has('README.md')).toBe(true);
    expect(files.has('.gitignore')).toBe(true);
    expect(files.has('.env.example')).toBe(true);
    expect(files.has('biome.json')).toBe(true);
    expect(files.has('.vscode/settings.json')).toBe(true);
  });

  it('creates app directory stubs', () => {
    const files = generateProjectStructure('MyApp', {});
    expect(files.has('app/capabilities/.gitkeep')).toBe(true);
    expect(files.has('app/entities/.gitkeep')).toBe(true);
    expect(files.has('app/flows/.gitkeep')).toBe(true);
    expect(files.has('app/events/.gitkeep')).toBe(true);
    expect(files.has('app/prompts/.gitkeep')).toBe(true);
  });

  it('uses kebab-case for app name in package.json', () => {
    const files = generateProjectStructure('MyAwesomeApp', {});
    const pkg = JSON.parse(files.get('package.json') ?? '{}');
    expect(pkg.name).toBe('my-awesome-app');
  });

  it('includes AI provider config when specified', () => {
    const opts: CreateOptions = { ai: 'anthropic' };
    const files = generateProjectStructure('App', opts);
    const config = files.get('config/app.config.ts') ?? '';
    expect(config).toContain('anthropic');
  });

  it('includes compliance profiles when specified', () => {
    const opts: CreateOptions = { compliance: 'gdpr,soc2' };
    const files = generateProjectStructure('App', opts);
    const config = files.get('config/app.config.ts') ?? '';
    expect(config).toContain('gdpr');
    expect(config).toContain('soc2');
  });

  it('includes database name from app name', () => {
    const files = generateProjectStructure('OrderService', {});
    const config = files.get('config/app.config.ts') ?? '';
    expect(config).toContain('order-service');
  });

  it('generates tsconfig with app and config in include', () => {
    const files = generateProjectStructure('MyApp', {});
    const tsconfig = JSON.parse(files.get('tsconfig.json') ?? '{}');
    expect(tsconfig.include).toEqual(['app', 'config']);
    expect(tsconfig.compilerOptions.rootDir).toBeUndefined();
  });

  it('generates biome.json with linter and formatter config', () => {
    const files = generateProjectStructure('MyApp', {});
    const biome = JSON.parse(files.get('biome.json') ?? '{}');
    expect(biome.linter.enabled).toBe(true);
    expect(biome.formatter.enabled).toBe(true);
    expect(biome.formatter.indentStyle).toBe('space');
    expect(biome.files.ignore).toContain('node_modules');
  });

  it('includes @biomejs/biome in devDependencies', () => {
    const files = generateProjectStructure('MyApp', {});
    const pkg = JSON.parse(files.get('package.json') ?? '{}');
    expect(pkg.devDependencies['@biomejs/biome']).toBeDefined();
  });

  it('includes lint and format scripts', () => {
    const files = generateProjectStructure('MyApp', {});
    const pkg = JSON.parse(files.get('package.json') ?? '{}');
    expect(pkg.scripts.lint).toBeDefined();
    expect(pkg.scripts.format).toBeDefined();
    expect(pkg.scripts['format:check']).toBeDefined();
  });

  it('generates .vscode/settings.json with biome formatter', () => {
    const files = generateProjectStructure('MyApp', {});
    const settings = JSON.parse(files.get('.vscode/settings.json') ?? '{}');
    expect(settings['editor.defaultFormatter']).toBe('biomejs.biome');
    expect(settings['editor.formatOnSave']).toBe(true);
  });

  it('flat mode is unchanged when monorepo is not set', () => {
    const files = generateProjectStructure('MyApp', {});
    expect(files.has('app/capabilities/.gitkeep')).toBe(true);
    expect(files.has('pnpm-workspace.yaml')).toBe(false);
    expect(files.has('backend/package.json')).toBe(false);
  });
});

describe('plumbus create --monorepo', () => {
  it('generates pnpm-workspace.yaml', () => {
    const files = generateProjectStructure('MyApp', { monorepo: true });
    expect(files.has('pnpm-workspace.yaml')).toBe(true);
    const yaml = files.get('pnpm-workspace.yaml') ?? '';
    expect(yaml).toContain('"backend"');
    expect(yaml).toContain('"frontend"');
    expect(yaml).toContain('"libs/*"');
  });

  it('generates root workspace package.json', () => {
    const files = generateProjectStructure('MyApp', { monorepo: true });
    const pkg = JSON.parse(files.get('package.json') ?? '{}');
    expect(pkg.name).toBe('my-app');
    expect(pkg.private).toBe(true);
    expect(pkg.scripts.build).toContain('pnpm -r');
  });

  it('generates tsconfig.base.json at root', () => {
    const files = generateProjectStructure('MyApp', { monorepo: true });
    expect(files.has('tsconfig.base.json')).toBe(true);
    const tsconfig = JSON.parse(files.get('tsconfig.base.json') ?? '{}');
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  it('generates backend package with correct deps', () => {
    const files = generateProjectStructure('MyApp', { monorepo: true });
    expect(files.has('backend/package.json')).toBe(true);
    const pkg = JSON.parse(files.get('backend/package.json') ?? '{}');
    expect(pkg.name).toBe('@my-app/backend');
    expect(pkg.dependencies['@plumbus/core']).toBeDefined();
    expect(pkg.dependencies['@my-app/shared']).toBe('workspace:*');
    expect(pkg.devDependencies['@biomejs/biome']).toBeDefined();
  });

  it('generates backend app directory stubs', () => {
    const files = generateProjectStructure('MyApp', { monorepo: true });
    expect(files.has('backend/app/capabilities/.gitkeep')).toBe(true);
    expect(files.has('backend/app/entities/.gitkeep')).toBe(true);
    expect(files.has('backend/app/flows/.gitkeep')).toBe(true);
    expect(files.has('backend/app/events/.gitkeep')).toBe(true);
    expect(files.has('backend/app/prompts/.gitkeep')).toBe(true);
    expect(files.has('backend/app/compliance/overrides/.gitkeep')).toBe(true);
  });

  it('generates backend config files', () => {
    const files = generateProjectStructure('MyApp', { monorepo: true });
    expect(files.has('backend/config/app.config.ts')).toBe(true);
    expect(files.has('backend/config/ai.config.ts')).toBe(true);
  });

  it('generates backend tsconfig extending base', () => {
    const files = generateProjectStructure('MyApp', { monorepo: true });
    const tsconfig = JSON.parse(files.get('backend/tsconfig.json') ?? '{}');
    expect(tsconfig.extends).toBe('../tsconfig.base.json');
    expect(tsconfig.include).toEqual(['app', 'config']);
  });

  it('generates frontend package with shared dep', () => {
    const files = generateProjectStructure('MyApp', { monorepo: true });
    expect(files.has('frontend/package.json')).toBe(true);
    const pkg = JSON.parse(files.get('frontend/package.json') ?? '{}');
    expect(pkg.name).toBe('@my-app/frontend');
    expect(pkg.dependencies['@my-app/shared']).toBe('workspace:*');
    expect(pkg.devDependencies['@biomejs/biome']).toBeDefined();
  });

  it('generates frontend src placeholder', () => {
    const files = generateProjectStructure('MyApp', { monorepo: true });
    expect(files.has('frontend/src/.gitkeep')).toBe(true);
  });

  it('generates shared libs package', () => {
    const files = generateProjectStructure('MyApp', { monorepo: true });
    expect(files.has('libs/shared/package.json')).toBe(true);
    const pkg = JSON.parse(files.get('libs/shared/package.json') ?? '{}');
    expect(pkg.name).toBe('@my-app/shared');
  });

  it('generates shared types placeholder', () => {
    const files = generateProjectStructure('MyApp', { monorepo: true });
    expect(files.has('libs/shared/types/.gitkeep')).toBe(true);
  });

  it('does not generate flat app/ stubs', () => {
    const files = generateProjectStructure('MyApp', { monorepo: true });
    expect(files.has('app/capabilities/.gitkeep')).toBe(false);
    expect(files.has('tsconfig.json')).toBe(false);
  });

  it('includes common root files', () => {
    const files = generateProjectStructure('MyApp', { monorepo: true });
    expect(files.has('.gitignore')).toBe(true);
    expect(files.has('backend/.env.example')).toBe(true);
    expect(files.has('biome.json')).toBe(true);
    expect(files.has('README.md')).toBe(true);
    expect(files.has('.vscode/settings.json')).toBe(true);
  });

  it('places .env.example in backend/ not root', () => {
    const files = generateProjectStructure('MyApp', { monorepo: true });
    expect(files.has('backend/.env.example')).toBe(true);
    expect(files.has('.env.example')).toBe(false);
  });

  it('uses **/.plumbus/generated/ glob in .gitignore', () => {
    const files = generateProjectStructure('MyApp', { monorepo: true });
    const gitignore = files.get('.gitignore') ?? '';
    expect(gitignore).toContain('**/.plumbus/generated/');
  });
});
