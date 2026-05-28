import type { ResolvedContext } from '../types/context.js';
import { renderContext } from './render-context.js';

export function buildSystemPrompt(args: {
  chatInstructions: string;
  audience: string;
  locale: string;
  behavioralReminder?: string;
  scopeDescription?: string;
  resolvedContext: ResolvedContext;
  allowedSourceHandles: string[];
  summary?: string;
}): string {
  const sections: string[] = [];
  sections.push(`## Identity\n${args.chatInstructions}`);
  sections.push(
    `## Audience\n[Audience: ${args.audience}] Only reference ${args.audience}-relevant surfaces.`,
  );
  sections.push(`## Language\n[Reply in '${args.locale}' only.] No mixed-language responses.`);
  if (args.behavioralReminder) {
    sections.push(`## Cooldown reminder\n${args.behavioralReminder}`);
  }
  if (args.scopeDescription) {
    sections.push(
      `## Scope\n${args.scopeDescription}\nRespond with structured output including inScope, answer, refusalReason, citedSources, requestedAction.`,
    );
  }
  sections.push(
    `## Citation contract\nAllowed source handles: ${args.allowedSourceHandles.join(', ') || '(none)'}. Never invent source IDs.`,
  );
  sections.push(`## Context\n${renderContext(args.resolvedContext)}`);
  if (args.summary) {
    sections.push(`## Earlier conversation summary\n${args.summary}`);
  }
  return sections.join('\n\n');
}
