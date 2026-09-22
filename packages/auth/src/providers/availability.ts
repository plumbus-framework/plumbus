export type ProviderAvailability = 'available' | 'unavailable';

export interface ProviderAvailabilityMap {
  get(providerId: string): ProviderAvailability;
  set(providerId: string, status: ProviderAvailability): void;
  snapshot(): Record<string, ProviderAvailability>;
}

export function createProviderAvailabilityMap(
  providerIds: readonly string[],
): ProviderAvailabilityMap {
  const state = new Map<string, ProviderAvailability>(providerIds.map((id) => [id, 'unavailable']));

  return {
    get(providerId) {
      return state.get(providerId) ?? 'unavailable';
    },
    set(providerId, status) {
      state.set(providerId, status);
    },
    snapshot() {
      return Object.fromEntries(state.entries());
    },
  };
}
