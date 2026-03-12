// ── @plumbus/ui Generators Barrel ──
export {
  generateCapabilityTypes,
  generateClientModule,
  generateErrorTypes,
  generateFlowTrigger,
  generateHooksModule,
  generateMutationHook,
  generateQueryHook,
  generateReactHook,
  generateTypedClient,
} from './client-generator.js';
export type { ClientGeneratorConfig, FlowTriggerInput } from './client-generator.js';

export {
  generateAuthFunctions,
  generateAuthModule,
  generateAuthTypes,
  generateRouteGuard,
  generateTenantContext,
  generateTokenUtils,
  generateUseAuthHook,
  generateUseCurrentUserHook,
} from './auth-generator.js';
export type { AuthHelperConfig } from './auth-generator.js';

export {
  generateAuthProvider,
  generateCapabilityPage,
  generateHomePage,
  generateLayout,
  generateNextjsTemplate,
  generatePackageJson,
  generatePlaceholderFiles,
  generateTsConfig,
} from './nextjs-template.js';
export type { GeneratedFile, NextjsTemplateConfig } from './nextjs-template.js';

export {
  extractFieldHint,
  extractFormHints,
  generateFormHintsCode,
  generateFormHintsModule,
} from './form-generator.js';
export type {
  FormFieldHint,
  FormFieldType,
  FormHints,
  FormValidation,
} from './form-generator.js';
