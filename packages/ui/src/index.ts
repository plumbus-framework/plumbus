// ── @plumbus/ui ──
// UI layer generators for Plumbus framework

export type { AuthHelperConfig } from './generators/auth-generator.js';
// Auth Helpers Generator
export {
  generateAuthFunctions,
  generateAuthModule,
  generateAuthTypes,
  generateRouteGuard,
  generateTenantContext,
  generateTokenUtils,
  generateUseAuthHook,
  generateUseCurrentUserHook,
} from './generators/auth-generator.js';
export type { ClientGeneratorConfig, FlowTriggerInput } from './generators/client-generator.js';
// Client & Hooks Generators
export {
  capabilityClientFnName,
  flowTriggerFnName,
  generateCapabilityTypes,
  generateClientModule,
  generateErrorTypes,
  generateFlowTrigger,
  generateHooksModule,
  generateMutationHook,
  generateQueryHook,
  generateReactHook,
  generateTypedClient,
} from './generators/client-generator.js';
export type {
  FormFieldHint,
  FormFieldType,
  FormHints,
  FormValidation,
} from './generators/form-generator.js';
// Form Generation Hints
export {
  extractFieldHint,
  extractFormHints,
  generateFormHintsCode,
  generateFormHintsModule,
} from './generators/form-generator.js';
export type { GeneratedFile, NextjsTemplateConfig } from './generators/nextjs-template.js';
// Next.js Template Generator
export {
  generateAuthProvider,
  generateCapabilityPage,
  generateEnvLocal,
  generateErrorBoundary,
  generateGlobalsCss,
  generateHomePage,
  generateLayout,
  generateLoadingComponent,
  generateLoginPage,
  generateNextjsTemplate,
  generatePackageJson,
  generatePlaceholderFiles,
  generatePostcssConfig,
  generateProxy,
  generateSignupPage,
  generateTsConfig,
} from './generators/nextjs-template.js';
export type { GeneratedTranslationFile } from './generators/translation-generator.js';
// Translation Generation
export { generateTranslationModule } from './generators/translation-generator.js';
