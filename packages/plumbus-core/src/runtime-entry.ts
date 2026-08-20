// ════════════════════════════════════════════════════════════════════════════
// Framework-internal runtime seam for `@plumbus/core/runtime`.
//
// WHAT THIS IS
// This subpath exists for code that *hosts* the Plumbus runtime: the framework
// packages that own a transport (`@plumbus/api`, `@plumbus/mcp`,
// `@plumbus/voice`, `@plumbus/voice-livekit`, `@plumbus/chat`) and the
// hand-written server bootstrap of an application that registers its own
// routes, workers, or transports. Those callers sit *above* the capability
// pipeline: they have already authenticated the request and must translate the
// result into an `ExecutionContext` before any capability runs.
//
// WHY IT IS NOT ON THE ROOT BARREL
// `createExecutionContext` mints the platform-established actor. Anything that
// can call it can fabricate or elevate one. Capability bodies, entity hooks,
// flow steps, and every other piece of ordinary application code receive a
// context — they never build one — so the factory is kept off `@plumbus/core`
// where that code reaches. Importing it requires naming this subpath, which is
// a visible, greppable, reviewable act rather than an autocomplete accident.
// Tests obtain a context through `@plumbus/core/testing` (`createTestContext`,
// `runCapability`) instead.
//
// COMPATIBILITY
// This is a framework seam, not SDK surface. It carries no compatibility
// guarantee for application code: names here may change or disappear in a minor
// release. Application code that imports it owns the upgrade cost. Everything
// an application is *meant* to build against stays on `@plumbus/core`.
// ════════════════════════════════════════════════════════════════════════════

export { createExecutionContext } from './execution/context-factory.js';
export type { ContextDependencies } from './execution/context-factory.js';
export type { ExecutionContext } from './types/context.js';
