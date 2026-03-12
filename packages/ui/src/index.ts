// ── @plumbus/ui ──
// UI layer generators for Plumbus framework

// Client & Hooks Generators
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
} from './generators/client-generator.js';
export type { ClientGeneratorConfig, FlowTriggerInput } from './generators/client-generator.js';

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
export type { AuthHelperConfig } from './generators/auth-generator.js';

// Next.js Template Generator
export {
  generateApiRouteHelper,
  generateAuthProvider,
  generateCapabilityPage,
  generateEnvLocal,
  generateErrorBoundary,
  generateHomePage,
  generateLayout,
  generateLoadingComponent,
  generateMiddleware,
  generateNextjsTemplate,
  generatePackageJson,
  generatePlaceholderFiles,
  generateTsConfig,
} from './generators/nextjs-template.js';
export type { GeneratedFile, NextjsTemplateConfig } from './generators/nextjs-template.js';

// Form Generation Hints
export {
  extractFieldHint,
  extractFormHints,
  generateFormHintsCode,
  generateFormHintsModule,
} from './generators/form-generator.js';
export type {
  FormFieldHint,
  FormFieldType,
  FormHints,
  FormValidation,
} from './generators/form-generator.js';
