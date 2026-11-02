import type { Repository } from '@plumbus/core';

// A custom repository / test double written against core 0.8.2, before findManyFields.
// It must keep satisfying Repository in every 0.8.x release.
type Row = { id: string; name: string };

export const legacyRepository: Repository<Row> = {
  findById: async () => null,
  create: async (data) => ({ id: '1', name: '', ...data }) as Row,
  createMany: async () => [],
  update: async (id) => ({ id, name: '' }),
  delete: async () => {},
  findMany: async () => [],
  count: async () => 0,
  aggregate: async () => [],
};
