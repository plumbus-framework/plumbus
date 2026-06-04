import type { GeneratedFile } from '../types.js';
import { EDITABLE_HEADER } from './constants.js';

export function generateContent(): GeneratedFile {
  return {
    path: 'entrypoints/content.ts',
    content: `${EDITABLE_HEADER}
import { defineContentScript } from 'wxt/utils/define-content-script';
// import { invoke } from '../../src/invoke.js';

export default defineContentScript({
  // Registered at runtime (not declared statically in the manifest), so 'matches' may stay
  // empty until you target your app origins. Avoid <all_urls> in production.
  registration: 'runtime',
  matches: [],
  main() {
    // Example: invoke a capability from a content script (no direct token access).
    // const result = await invoke('yourCapabilityKey', { /* input */ });
    // if (result.ok) console.debug('[plumbus]', result.data);
  },
});
`,
  };
}
