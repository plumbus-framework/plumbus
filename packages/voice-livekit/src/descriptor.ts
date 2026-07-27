import type { TransportProviderCapabilities } from '@plumbus/voice/provider-kit';

export const LIVEKIT_TRANSPORT_DESCRIPTOR: TransportProviderCapabilities = {
  id: 'livekit',
  kind: 'transport',
  displayName: 'LiveKit',
  credentialSchema: [
    { field: 'url', required: true },
    { field: 'apiKey', required: true },
    { field: 'apiSecret', required: true },
  ],
  hosting: 'cloud',
  realtime: true,
  modes: ['pushToTalk', 'continuous'],
};
