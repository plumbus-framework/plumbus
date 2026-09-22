import type { ChatEvent } from '../types/event.js';
import type { GuardVerdict } from '../types/policy.js';

export interface ExecutionTrace {
  resolvedSources: unknown;
  systemPrompt?: string;
  modelOutput?: Record<string, unknown>;
  guardVerdicts: Array<{ name: string; verdict: GuardVerdict }>;
  events: ChatEvent[];
}

export class TraceRecorder {
  trace: ExecutionTrace = {
    resolvedSources: null,
    guardVerdicts: [],
    events: [],
  };

  recordResolved(sources: unknown): void {
    this.trace.resolvedSources = sources;
  }

  recordPrompt(prompt: string): void {
    this.trace.systemPrompt = prompt;
  }

  recordModelOutput(output: Record<string, unknown>): void {
    this.trace.modelOutput = output;
  }

  recordGuard(name: string, verdict: GuardVerdict): void {
    this.trace.guardVerdicts.push({ name, verdict });
  }

  recordEvent(evt: ChatEvent): void {
    this.trace.events.push(evt);
  }
}
