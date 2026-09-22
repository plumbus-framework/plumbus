// packages/chat/src/runtime/chat-registry.ts

export interface ChatRegistry {
  /** True when a prompt with this name is registered in the runtime prompt registry. */
  hasPrompt(name: string): boolean;
}

/**
 * Build a ChatRegistry from the runtime PromptRegistry (or any object exposing
 * `has(name)`). Wire this at chat-route registration so Path B can fail closed
 * with 'chat.prompt_not_registered' when chat.toolRound / chat.scopeCheck were
 * not re-exported into app/prompts/.
 */
export function createChatRegistry(promptRegistry: { has(name: string): boolean }): ChatRegistry {
  return { hasPrompt: (name) => promptRegistry.has(name) };
}
