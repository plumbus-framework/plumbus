// Examples use the built public barrels without becoming publishable packages.
export {
  createErrorService,
  createAIService,
  createCostTracker,
  defineCapability,
  executeCapability,
} from '../../../packages/plumbus-core/dist/index.js';
// The smoke app hosts its own capability calls, so it mints contexts through the runtime seam.
export { createExecutionContext } from '../../../packages/plumbus-core/dist/runtime-entry.js';
export { z } from '../../../packages/plumbus-core/dist/zod/index.js';
export { createLayaDecisionAdapter } from '../../../packages/ai-decision-laya/dist/index.js';
export { createTypeSafeDecisionAdapter } from '../../../packages/ai-decision-typesafe/dist/index.js';
