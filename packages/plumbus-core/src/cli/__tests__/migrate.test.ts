import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──

// node:fs must be mocked via vi.mock for ESM
const mockMkdirSync = vi.fn((_p: string, _o?: any) => undefined as any);
const mockWriteFileSync = vi.fn((_p: string, _d: string, _o?: any) => {});
const mockExistsSync = vi.fn((_p: string) => false);
const mockReaddirSync = vi.fn((_p: string): string[] => []);
const mockReadFileSync = vi.fn((_p: string, _o?: any) => '{}');

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: (p: string, o?: any) => mockMkdirSync(p, o),
    writeFileSync: (p: string, d: string, o?: any) => mockWriteFileSync(p, d, o),
    existsSync: (p: string) => mockExistsSync(p),
    readdirSync: (p: string) => mockReaddirSync(p),
    readFileSync: (p: string, o?: any) => mockReadFileSync(p, o),
    default: {
      ...actual,
      mkdirSync: (p: string, o?: any) => mockMkdirSync(p, o),
      writeFileSync: (p: string, d: string, o?: any) => mockWriteFileSync(p, d, o),
      existsSync: (p: string) => mockExistsSync(p),
      readdirSync: (p: string) => mockReaddirSync(p),
      readFileSync: (p: string, o?: any) => mockReadFileSync(p, o),
    },
  };
});

vi.mock('../discover.js', () => ({
  discoverResources: vi.fn(async () => ({
    capabilities: [],
    entities: [
      Object.freeze({
        name: 'TestEntity',
        fields: [
          { name: 'id', type: 'id', required: true },
          { name: 'title', type: 'string', required: true },
        ],
        tenantScoped: true,
      }),
    ],
    flows: [],
    events: [],
    prompts: [],
  })),
}));

vi.mock('../../config/loader.js', () => ({
  loadConfig: vi.fn(() => ({
    database: {
      host: 'localhost',
      port: 5432,
      database: 'test_db',
      user: 'postgres',
      password: '',
    },
  })),
}));

vi.mock('../../data/migration.js', () => ({
  collectSchemas: vi.fn(() => ({
    test_entities: { _: 'mock_table' },
  })),
  applyMigrations: vi.fn(async () => {}),
  rollbackLastMigration: vi.fn(async () => ({
    status: 'rolled_back',
    rolledBack: '0001_init',
  })),
}));

vi.mock('drizzle-kit/api', () => ({
  generateDrizzleJson: vi.fn((_schemas: unknown, _prevId?: string) => ({
    id: 'snapshot-1',
    tables: { test_entities: {} },
  })),
  generateMigration: vi.fn(async () => ['CREATE TABLE "test_entities" ("id" uuid PRIMARY KEY);']),
  pushSchema: vi.fn(async () => ({
    hasDataLoss: false,
    warnings: [],
    statementsToExecute: ['CREATE TABLE ...'],
    apply: vi.fn(async () => {}),
  })),
}));

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => ({})),
}));

vi.mock('postgres', () => ({
  default: vi.fn(() => {
    const sql = Object.assign(
      vi.fn(async () => []),
      { end: vi.fn(async () => {}), unsafe: vi.fn(async () => {}) },
    );
    return sql;
  }),
}));

import { Command } from 'commander';
import { generateDrizzleJson, generateMigration, pushSchema } from 'drizzle-kit/api';
import { applyMigrations, collectSchemas, rollbackLastMigration } from '../../data/migration.js';
import { registerDbCommand, registerMigrateCommand } from '../commands/migrate.js';
import { discoverResources } from '../discover.js';

// ── Helpers ──

function createTestProgram() {
  const program = new Command();
  program.exitOverride(); // Throw instead of process.exit
  registerMigrateCommand(program);
  registerDbCommand(program);
  return program;
}

describe('plumbus migrate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Reset fs mocks to safe defaults
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    mockReadFileSync.mockReturnValue('{}');
  });

  describe('migrate generate', () => {
    it('discovers entities and generates migration SQL', async () => {
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'migrate', 'generate']);
      expect(discoverResources).toHaveBeenCalled();
      expect(collectSchemas).toHaveBeenCalled();
      expect(generateDrizzleJson).toHaveBeenCalled();
      expect(generateMigration).toHaveBeenCalled();
    });

    it('warns when no entities are found', async () => {
      vi.mocked(collectSchemas).mockReturnValueOnce({});
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'migrate', 'generate']);
      expect(generateMigration).not.toHaveBeenCalled();
    });

    it('outputs JSON when --json is passed', async () => {
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'migrate', 'generate', '--json']);
      const output = vi
        .mocked(console.log)
        .mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('"status"'));
      expect(output).toBeDefined();
      const parsed = JSON.parse(output?.[0] as string);
      expect(parsed.status).toBe('generated');
      expect(parsed.statements).toBe(1);
    });

    it('reports no changes when migration is empty', async () => {
      vi.mocked(generateMigration).mockResolvedValueOnce([]);
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'migrate', 'generate', '--json']);
      const output = vi
        .mocked(console.log)
        .mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('"no_changes"'));
      expect(output).toBeDefined();
    });

    it('writes migration file and snapshot to drizzle/', async () => {
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'migrate', 'generate']);
      // Should create drizzle/meta/ directory
      expect(mockMkdirSync).toHaveBeenCalled();
      // Should write migration SQL + snapshot + journal
      expect(mockWriteFileSync).toHaveBeenCalledTimes(3);
    });
  });

  describe('migrate apply', () => {
    it('applies pending migrations', async () => {
      mockExistsSync.mockReturnValue(true);
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'migrate', 'apply']);
      expect(applyMigrations).toHaveBeenCalled();
    });

    it('warns when no drizzle/ folder exists', async () => {
      mockExistsSync.mockReturnValue(false);
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'migrate', 'apply', '--json']);
      const output = vi
        .mocked(console.log)
        .mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('"no_migrations"'));
      expect(output).toBeDefined();
    });
  });

  describe('migrate push', () => {
    it('uses pushSchema to diff and apply against the database', async () => {
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'migrate', 'push']);
      expect(discoverResources).toHaveBeenCalled();
      expect(collectSchemas).toHaveBeenCalled();
      expect(pushSchema).toHaveBeenCalled();
    });

    it('warns when no entities found', async () => {
      vi.mocked(collectSchemas).mockReturnValueOnce({});
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'migrate', 'push', '--json']);
      const output = vi
        .mocked(console.log)
        .mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('"no_entities"'));
      expect(output).toBeDefined();
    });

    it('reports no changes when pushSchema returns no statements', async () => {
      vi.mocked(pushSchema).mockResolvedValueOnce({
        hasDataLoss: false,
        warnings: [],
        statementsToExecute: [],
        apply: vi.fn(async () => {}),
      });
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'migrate', 'push', '--json']);
      const output = vi
        .mocked(console.log)
        .mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('"no_changes"'));
      expect(output).toBeDefined();
    });

    it('outputs JSON with statement count', async () => {
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'migrate', 'push', '--json']);
      const output = vi
        .mocked(console.log)
        .mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('"pushed"'));
      expect(output).toBeDefined();
      const parsed = JSON.parse(output?.[0] as string);
      expect(parsed.status).toBe('pushed');
      expect(parsed.statements).toBe(1);
    });
  });

  describe('migrate rollback', () => {
    it('rolls back the last migration', async () => {
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'migrate', 'rollback']);
      expect(rollbackLastMigration).toHaveBeenCalled();
    });

    it('outputs JSON when --json is passed', async () => {
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'migrate', 'rollback', '--json']);
      const output = vi
        .mocked(console.log)
        .mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('"rolled_back"'));
      expect(output).toBeDefined();
    });
  });
});

describe('plumbus db', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('db create', () => {
    it('creates the application database', async () => {
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'db', 'create', '--json']);
      const output = vi
        .mocked(console.log)
        .mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('"database"'));
      expect(output).toBeDefined();
      const parsed = JSON.parse(output?.[0] as string);
      expect(parsed.database).toBe('test_db');
    });

    it('creates test database when --test is passed', async () => {
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'db', 'create', '--test', '--json']);
      const output = vi
        .mocked(console.log)
        .mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('"testDatabase"'));
      expect(output).toBeDefined();
      const parsed = JSON.parse(output?.[0] as string);
      expect(parsed.testDatabase).toBe('test_db_test');
    });
  });

  describe('db reset', () => {
    it('drops and recreates the database', async () => {
      mockExistsSync.mockReturnValue(false);
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'db', 'reset', '--json']);
      const output = vi
        .mocked(console.log)
        .mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('"reset"'));
      expect(output).toBeDefined();
      const parsed = JSON.parse(output?.[0] as string);
      expect(parsed.database).toBe('test_db');
    });

    it('resets test database when --test is passed', async () => {
      mockExistsSync.mockReturnValue(false);
      const program = createTestProgram();
      await program.parseAsync(['node', 'plumbus', 'db', 'reset', '--test', '--json']);
      const output = vi
        .mocked(console.log)
        .mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('"reset"'));
      expect(output).toBeDefined();
      const parsed = JSON.parse(output?.[0] as string);
      expect(parsed.database).toBe('test_db_test');
    });
  });
});
