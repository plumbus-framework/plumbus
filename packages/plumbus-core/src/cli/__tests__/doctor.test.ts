import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkAgentWiring,
  checkLegacyArtifacts,
  checkMcpAgentsConfigured,
  checkMcpPublicCapabilityFootgun,
  checkMcpSkillFilesFresh,
  checkNodeVersion,
  checkPlumbusUi,
  checkPostgreSQL,
  checkRedis,
  checkTypeScript,
  runDoctorChecks,
  runFullDoctorChecks,
} from '../commands/doctor.js';
import {
  generateAgentsMd,
  generateCopilotInstructions,
  generateCursorCapabilityRule,
  generateCursorRule,
} from '../commands/init.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('plumbus doctor', () => {
  it('checks Node.js version', () => {
    const check = checkNodeVersion();
    expect(check.name).toBe('node');
    // We're running on Node 20+, should pass
    expect(check.status).toBe('ok');
    expect(check.message).toContain('Node.js');
  });

  it('returns all expected checks', () => {
    const checks = runDoctorChecks();
    const names = checks.map((c) => c.name);
    expect(names).toContain('node');
    expect(names).toContain('typescript');
    expect(names).toContain('@plumbus/ui');
    expect(names).toContain('package.json');
    expect(names).toContain('config');
    expect(names).toContain('app-structure');
    expect(names).toContain('agent-wiring');
    expect(names).toContain('legacy-artifacts');
  });

  it('detects TypeScript availability', () => {
    const check = checkTypeScript();
    expect(check.name).toBe('typescript');
    // TypeScript is installed in our dev deps
    expect(['ok', 'fail']).toContain(check.status);
  });

  it('returns structured check results', () => {
    const checks = runDoctorChecks();
    for (const check of checks) {
      expect(check).toHaveProperty('name');
      expect(check).toHaveProperty('status');
      expect(check).toHaveProperty('message');
      expect(['ok', 'warn', 'fail']).toContain(check.status);
    }
  });

  it('checkPostgreSQL returns a structured check result', async () => {
    const check = await checkPostgreSQL();
    expect(check.name).toBe('postgresql');
    expect(['ok', 'warn', 'fail']).toContain(check.status);
    expect(check.message).toBeTruthy();
  });

  it('checkRedis returns a structured check result', async () => {
    const check = await checkRedis();
    expect(check.name).toBe('redis');
    expect(['ok', 'warn', 'fail']).toContain(check.status);
    expect(check.message).toBeTruthy();
  });

  it('runFullDoctorChecks includes connectivity checks', async () => {
    const checks = await runFullDoctorChecks();
    const names = checks.map((c) => c.name);
    expect(names).toContain('node');
    expect(names).toContain('postgresql');
    expect(names).toContain('redis');
    expect(checks.length).toBeGreaterThan(runDoctorChecks().length);
  });

  it('checkPlumbusUi returns a structured check result', () => {
    const check = checkPlumbusUi();
    expect(check.name).toBe('@plumbus/ui');
    expect(['ok', 'warn', 'fail']).toContain(check.status);
    expect(check.message).toBeTruthy();
  });

  it('checkLegacyArtifacts returns a structured check result', () => {
    const check = checkLegacyArtifacts();
    expect(check.name).toBe('legacy-artifacts');
    expect(['ok', 'warn', 'fail']).toContain(check.status);
    expect(check.message).toBeTruthy();
  });

  it('checkAgentWiring returns ok when no generated wiring exists', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-doctor-agent-wiring-'));
    try {
      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
      const check = checkAgentWiring();
      expect(check.name).toBe('agent-wiring');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('No generated agent wiring detected');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('checkAgentWiring warns on unversioned generated wiring', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-doctor-agent-wiring-'));
    try {
      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
      mkdirSync(path.join(tempDir, '.github'), { recursive: true });
      writeFileSync(
        path.join(tempDir, '.github', 'copilot-instructions.md'),
        '# Plumbus Framework — Copilot Instructions\n\nlegacy content',
        'utf-8',
      );

      const check = checkAgentWiring();
      expect(check.status).toBe('warn');
      expect(check.message).toContain('unversioned');
      expect(check.message).toContain('plumbus init --force');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('checkAgentWiring recommends patch for stale patchable wiring', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-doctor-agent-wiring-'));
    try {
      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
      mkdirSync(path.join(tempDir, '.github'), { recursive: true });
      writeFileSync(
        path.join(tempDir, '.github', 'copilot-instructions.md'),
        [
          '<!-- plumbus:agent-wiring version=1 format=copilot mode=reference layout=flat -->',
          '# Plumbus Framework — Copilot Instructions',
          '',
          '<!-- /plumbus:agent-wiring -->',
        ].join('\n'),
        'utf-8',
      );

      const check = checkAgentWiring();
      expect(check.status).toBe('warn');
      expect(check.message).toContain('version 1');
      expect(check.message).toContain('plumbus init --patch');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('checkAgentWiring accepts current generated wiring', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-doctor-agent-wiring-'));
    try {
      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
      mkdirSync(path.join(tempDir, '.github'), { recursive: true });
      mkdirSync(path.join(tempDir, '.cursor', 'rules'), { recursive: true });
      writeFileSync(
        path.join(tempDir, '.github', 'copilot-instructions.md'),
        generateCopilotInstructions(false),
        'utf-8',
      );
      writeFileSync(
        path.join(tempDir, '.cursor', 'rules', 'plumbus.mdc'),
        generateCursorRule(false),
        'utf-8',
      );
      writeFileSync(
        path.join(tempDir, '.cursor', 'rules', 'plumbus-capabilities.mdc'),
        generateCursorCapabilityRule(),
        'utf-8',
      );
      writeFileSync(path.join(tempDir, 'AGENTS.md'), generateAgentsMd(false), 'utf-8');

      const check = checkAgentWiring();
      expect(check.status).toBe('ok');
      expect(check.message).toContain('template version 9');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('checkAgentWiring recommends patch when cursor wiring is incomplete', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-doctor-agent-wiring-'));
    try {
      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
      mkdirSync(path.join(tempDir, '.cursor', 'rules'), { recursive: true });
      writeFileSync(
        path.join(tempDir, '.cursor', 'rules', 'plumbus.mdc'),
        generateCursorRule(false),
        'utf-8',
      );

      const check = checkAgentWiring();
      expect(check.status).toBe('warn');
      expect(check.message).toContain('Cursor wiring is incomplete');
      expect(check.message).toContain('plumbus init --patch');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('checkAgentWiring ignores non-generated AGENTS.md files', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-doctor-agent-wiring-'));
    try {
      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
      writeFileSync(
        path.join(tempDir, 'AGENTS.md'),
        '# Framework Development Notes\n\nThis is not generated by plumbus init.',
        'utf-8',
      );

      const check = checkAgentWiring();
      expect(check.status).toBe('ok');
      expect(check.message).toContain('No generated agent wiring detected');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('MCP doctor checks', () => {
  it('checkMcpAgentsConfigured returns null when @plumbus/mcp is not installed', () => {
    const result = checkMcpAgentsConfigured();
    expect(result === null || result.status === 'ok' || result.status === 'warn').toBe(true);
  });

  it('checkMcpPublicCapabilityFootgun returns null or non-failing in test env', async () => {
    const result = await checkMcpPublicCapabilityFootgun();
    expect(result === null || ['ok', 'warn'].includes(result.status)).toBe(true);
  });

  it('checkMcpSkillFilesFresh returns null or non-failing in test env', async () => {
    const result = await checkMcpSkillFilesFresh();
    expect(result === null || ['ok', 'warn'].includes(result.status)).toBe(true);
  });
});
