// ── Define Functions Module ──
// The five define*() functions that create frozen contract objects for each
// Plumbus primitive: capabilities, entities, events, flows, and prompts.
// These are the primary SDK surface for application developers.

export { defineCapability } from './defineCapability.js';
export { defineEntity } from './defineEntity.js';
export { defineEvent } from './defineEvent.js';
export { defineFlow } from './defineFlow.js';
export { definePrompt } from './definePrompt.js';
