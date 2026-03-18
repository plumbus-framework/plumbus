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

  it('generates .vscode/settings.json with biome formatter', () => {
    const files = generateProjectStructure('MyApp', {});
    const settings = JSON.parse(files.get('.vscode/settings.json') ?? '{}');
    expect(settings['editor.defaultFormatter']).toBe('biomejs.biome');
    expect(settings['editor.formatOnSave']).toBe(true);
  });
});
