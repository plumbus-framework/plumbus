import type { ExecutionContext, RouteGeneratorConfig } from '@plumbus/core';
import { createExecutionContext, type ContextDependencies } from '@plumbus/core';

export interface CreateVoiceExecutionContextArgs {
  voiceName: string;
  sessionId: string;
  userId?: string;
  tenantId?: string;
  input?: Record<string, unknown>;
  createDependencies: (auth: {
    userId: string;
    tenantId?: string;
    roles: string[];
    scopes: string[];
    provider: string;
  }) => ContextDependencies;
}

export interface CreateVoiceExecutionContextFromRouteArgs {
  userId: string;
  tenantId?: string;
}

export function createVoiceExecutionContext(
  routeConfig: RouteGeneratorConfig,
  args: CreateVoiceExecutionContextFromRouteArgs,
): ExecutionContext;
export function createVoiceExecutionContext(
  args: CreateVoiceExecutionContextArgs,
): ExecutionContext;
export function createVoiceExecutionContext(
  routeConfigOrArgs: RouteGeneratorConfig | CreateVoiceExecutionContextArgs,
  maybeArgs?: CreateVoiceExecutionContextFromRouteArgs,
): ExecutionContext {
  if (maybeArgs) {
    const routeConfig = routeConfigOrArgs as RouteGeneratorConfig;
    const deps = routeConfig.createDependencies({
      userId: maybeArgs.userId,
      tenantId: maybeArgs.tenantId,
      roles: ['user'],
      scopes: [],
      provider: 'voice',
    });
    return createExecutionContext(deps);
  }

  const args = routeConfigOrArgs as CreateVoiceExecutionContextArgs;
  const deps = args.createDependencies({
    userId: args.userId ?? 'voice-user',
    tenantId: args.tenantId,
    roles: ['user'],
    scopes: [],
    provider: 'voice',
  });

  return createExecutionContext(deps);
}
