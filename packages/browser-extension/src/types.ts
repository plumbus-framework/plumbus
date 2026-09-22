import type { CapabilityContract } from '@plumbus/core';

export interface FlowTriggerInput {
  name: string;
  domain?: string;
  description?: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

/** Registry row: invoke message key → client export name. */
export interface RegistryEntry {
  messageKey: string;
  exportName: string;
}

export interface BrowserExtensionScaffoldConfig {
  appName: string;
  apiBaseUrl: string;
  browsers?: ('chrome' | 'firefox')[];
  auth?: boolean;
  registryEntries: RegistryEntry[];
  /** Registry messageKey for the popup sample invoke (from @plumbus/ui naming at scaffold time). */
  sampleMessageKey?: string;
}

export interface BrowserExtensionScaffoldInput {
  config: BrowserExtensionScaffoldConfig;
  capabilities: CapabilityContract[];
  flows: FlowTriggerInput[];
}
