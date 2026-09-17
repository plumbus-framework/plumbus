import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ServerExtensions } from './bootstrap.js';

/** Load optional hooks from app/server.ts or app/server.js. */
export async function loadServerExtensions(cwd = process.cwd()): Promise<ServerExtensions> {
  let unregisterTsx: (() => void) | undefined;
  try {
    const req = createRequire(import.meta.url);
    const tsxPath = req.resolve('tsx/esm/api');
    const tsx = await import(pathToFileURL(tsxPath).href);
    unregisterTsx = tsx.register();
  } catch {
    // tsx not available
  }

  const extensions: ServerExtensions = {};
  for (const ext of ['app/server.ts', 'app/server.js']) {
    const extPath = path.resolve(cwd, ext);
    if (!fs.existsSync(extPath)) continue;
    try {
      const mod = await import(pathToFileURL(extPath).href);
      extensions.onRoutesRegistered = mod.onRoutesRegistered ?? mod.default?.onRoutesRegistered;
      extensions.resolveAiOverrides = mod.resolveAiOverrides ?? mod.default?.resolveAiOverrides;
      extensions.onCapabilityError = mod.onCapabilityError ?? mod.default?.onCapabilityError;
      extensions.onProcessError = mod.onProcessError ?? mod.default?.onProcessError;
      extensions.onAICostRecorded = mod.onAICostRecorded ?? mod.default?.onAICostRecorded;
      extensions.aiProviderConcurrency =
        mod.aiProviderConcurrency ?? mod.default?.aiProviderConcurrency;
      extensions.resolveAIProviderHeaders =
        mod.resolveAIProviderHeaders ?? mod.default?.resolveAIProviderHeaders;
      extensions.onAIProviderSpan = mod.onAIProviderSpan ?? mod.default?.onAIProviderSpan;
      extensions.enableStrictStructuredOutputs =
        mod.enableStrictStructuredOutputs ?? mod.default?.enableStrictStructuredOutputs;
      extensions.onFlowError = mod.onFlowError ?? mod.default?.onFlowError;
      extensions.credentials = mod.credentials ?? mod.default?.credentials;
      const schedulePlanes = mod.schedulePlanes ?? mod.default?.schedulePlanes;
      if (
        schedulePlanes &&
        typeof schedulePlanes.resolver?.resolve === 'function' &&
        typeof schedulePlanes.listTenantRefs === 'function'
      ) {
        extensions.schedulePlanes = schedulePlanes;
      }
      const bodyLimit = mod.bodyLimit ?? mod.default?.bodyLimit;
      if (typeof bodyLimit === 'number' && Number.isFinite(bodyLimit) && bodyLimit > 0) {
        extensions.bodyLimit = bodyLimit;
      }
      // Per-unit data-plane resolution for the whole runtime (`export const dataPlaneResolver`):
      // the worker pool resolves each claimed unit's plane and places flows on it; the server
      // places the flows requests start and, under `requestDataPlane: 'resolved'`, resolves
      // every request's repositories too.
      const dataPlaneResolver = mod.dataPlaneResolver ?? mod.default?.dataPlaneResolver;
      if (dataPlaneResolver && typeof dataPlaneResolver.resolve === 'function') {
        extensions.dataPlaneResolver = dataPlaneResolver;
      }
      const listTenantRefs = mod.listTenantRefs ?? mod.default?.listTenantRefs;
      if (typeof listTenantRefs === 'function') {
        extensions.listTenantRefs = listTenantRefs;
      }
      const untenantedDataPlane = mod.untenantedDataPlane ?? mod.default?.untenantedDataPlane;
      if (untenantedDataPlane === 'refuse' || untenantedDataPlane === 'control-plane') {
        extensions.untenantedDataPlane = untenantedDataPlane;
      }
      const resolveTenantRef = mod.resolveTenantRef ?? mod.default?.resolveTenantRef;
      if (typeof resolveTenantRef === 'function') {
        extensions.resolveTenantRef = resolveTenantRef;
      }
      const requestDataPlane = mod.requestDataPlane ?? mod.default?.requestDataPlane;
      if (requestDataPlane === 'resolved' || requestDataPlane === 'control-plane') {
        extensions.requestDataPlane = requestDataPlane;
      }
      const workerDataPlane = mod.workerDataPlane ?? mod.default?.workerDataPlane;
      if (workerDataPlane === 'resolved' || workerDataPlane === 'control-plane') {
        extensions.workerDataPlane = workerDataPlane;
      }
      const frameworkSchema = mod.frameworkSchema ?? mod.default?.frameworkSchema;
      if (typeof frameworkSchema === 'string' && frameworkSchema.trim() !== '') {
        extensions.frameworkSchema = frameworkSchema;
      }
    } catch {
      // caller may log
    }
    break;
  }

  unregisterTsx?.();
  return extensions;
}
