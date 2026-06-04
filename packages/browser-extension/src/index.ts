// ── @plumbus/browser-extension ──
// WXT browser-extension scaffolder for Plumbus apps.

export { generateBrowserExtensionScaffold } from './generators/scaffold.js';
export { hostPermission, apiOrigin } from './generators/constants.js';
export { INVOKE_MESSAGE_TYPE } from './generators/invoke.js';
export { selectSampleCapability, isZeroInputCapabilityInput } from './sample-capability.js';
export {
  assertValidAppName,
  assertValidClientExportName,
  JS_IDENTIFIER,
} from './scaffold-validation.js';
export type {
  BrowserExtensionScaffoldConfig,
  BrowserExtensionScaffoldInput,
  FlowTriggerInput,
  GeneratedFile,
  RegistryEntry,
} from './types.js';
