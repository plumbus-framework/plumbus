import { describe, expect, it } from 'vitest';
import {
  generateAgentsMd,
  generateCopilotInstructions,
  generateCursorCapabilityRule,
  generateCursorRule,
  generateProjectBrief,
} from '../commands/init.js';

describe('plumbus init', () => {
  describe('Copilot instructions', () => {
    it('generates reference-mode instructions', () => {
      const content = generateCopilotInstructions(false);
      expect(content).toContain('Plumbus Framework');
      expect(content).toContain('node_modules/plumbus-core/instructions/framework.md');
      expect(content).toContain('node_modules/plumbus-core/instructions/capabilities.md');
      expect(content).toContain('Edit Zones');
    });

    it('generates inline-mode instructions', () => {
      const content = generateCopilotInstructions(true);
      expect(content).toContain('Plumbus Framework');
      expect(content).toContain('bundled instruction files');
      // Should not reference node_modules in SDK Reference section
      expect(content).not.toContain('node_modules/plumbus-core/instructions/');
    });
  });

  describe('Cursor rules', () => {
    it('generates main rule with frontmatter', () => {
      const content = generateCursorRule(false);
      expect(content).toContain('---');
      expect(content).toContain('description:');
      expect(content).toContain('globs: app/**');
      expect(content).toContain('node_modules/plumbus-core/instructions/');
    });

    it('generates capability-specific rule', () => {
      const content = generateCursorCapabilityRule();
      expect(content).toContain('globs: app/capabilities/**');
      expect(content).toContain('defineCapability()');
    });
  });

  describe('AGENTS.md', () => {
    it('generates agent-agnostic reference format', () => {
      const content = generateAgentsMd(false);
      expect(content).toContain('AGENTS.md');
      expect(content).toContain('Directory Structure');
      expect(content).toContain('Edit Zones');
      expect(content).toContain('node_modules/plumbus-core/instructions/');
    });

    it('generates inline format', () => {
      const content = generateAgentsMd(true);
      expect(content).toContain('inline');
      // Should not reference node_modules in SDK Reference section
      expect(content).not.toContain('node_modules/plumbus-core/instructions/');
    });
  });

  describe('Project brief', () => {
    it('generates a placeholder brief', () => {
      const brief = generateProjectBrief();
      expect(brief).toContain('Project Brief');
      expect(brief).toContain('plumbus agent sync');
    });
  });
});
