// A faithful, dependency-free in-memory data layer — a plain-JS port of
// @plumbus/core's testing `createInMemoryRepository` + `createTestData`.
//
// Why not import @plumbus/core/testing? That module imports `vitest` at load
// time and throws outside a vitest run. This port has identical repository
// semantics (create / findById / findMany filters + order/limit / updateWhere
// CAS / count / aggregate) but runs under plain node — so the chat runtime's
// ctx.data.ChatSession / ChatTurn writes behave exactly as in the framework's
// own tests, with no Postgres and no test runner.

function toColumnArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function createInMemoryRepository(initialData) {
  const store = new Map();
  let idCounter = 0;
  if (initialData) {
    for (const item of initialData) {
      const id = item.id ?? `mem-${++idCounter}`;
      store.set(id, { ...item, id });
    }
  }

  function filterRows(query, options) {
    let results = [...store.values()];
    if (query) {
      results = results.filter((item) =>
        Object.entries(query).every(([key, value]) => item[key] === value),
      );
    }
    if (options?.dateFilters) {
      for (const [field, range] of Object.entries(options.dateFilters)) {
        if (range.gte) {
          const gte = range.gte instanceof Date ? range.gte : new Date(range.gte);
          results = results.filter((item) => item[field] && new Date(item[field]) >= gte);
        }
        if (range.lte) {
          const lte = range.lte instanceof Date ? range.lte : new Date(range.lte);
          results = results.filter((item) => item[field] && new Date(item[field]) <= lte);
        }
      }
    }
    if (options?.in) {
      for (const [field, vals] of Object.entries(options.in)) {
        if (!vals.length) continue;
        const allowed = new Set(vals.map((v) => String(v)));
        results = results.filter((item) => item[field] != null && allowed.has(String(item[field])));
      }
    }
    if (options?.notEq) {
      for (const [field, val] of Object.entries(options.notEq)) {
        results = results.filter((item) => item[field] != null && item[field] !== val);
      }
    }
    if (options?.search?.term) {
      const term = options.search.term.toLowerCase();
      const cols = options.search.columns;
      results = results.filter((item) =>
        cols.some((col) =>
          String(item[col] ?? '')
            .toLowerCase()
            .includes(term),
        ),
      );
    }
    if (options?.orderBy) {
      const specs =
        typeof options.orderBy === 'string'
          ? [{ column: options.orderBy, dir: options.orderDir }]
          : options.orderBy;
      results.sort((a, b) => {
        for (const spec of specs) {
          const dir = (spec.dir ?? options.orderDir) === 'asc' ? 1 : -1;
          const av = a[spec.column];
          const bv = b[spec.column];
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
        }
        return 0;
      });
    }
    return results;
  }

  return {
    async findById(id) {
      return store.get(id) ?? null;
    },
    async create(data) {
      const id = data.id ?? `mem-${++idCounter}`;
      const record = { ...data, id };
      store.set(id, record);
      return record;
    },
    async createMany(records) {
      const out = [];
      for (const data of records) {
        const id = data.id ?? `mem-${++idCounter}`;
        const record = { ...data, id };
        store.set(id, record);
        out.push(record);
      }
      return out;
    },
    async update(id, updates) {
      const existing = store.get(id);
      if (!existing) throw new Error(`Record not found: ${id}`);
      const updated = { ...existing, ...updates };
      store.set(id, updated);
      return updated;
    },
    async updateWhere(id, predicate, updates) {
      const existing = store.get(id);
      if (!existing) return { matched: false, row: null };
      const ok = Object.entries(predicate).every(([k, v]) => {
        const actual = existing[k];
        if (v === null) return actual === null || actual === undefined;
        return actual === v;
      });
      if (!ok) return { matched: false, row: null };
      const updated = { ...existing, ...updates };
      store.set(id, updated);
      return { matched: true, row: updated };
    },
    async delete(id) {
      store.delete(id);
    },
    async findMany(query, options) {
      let results = filterRows(query, options);
      if (options?.offset) results = results.slice(options.offset);
      if (options?.limit) results = results.slice(0, options.limit);
      return results;
    },
    async count(query, options) {
      return filterRows(query, options).length;
    },
    async aggregate(query, options) {
      const rows = filterRows(query, {
        dateFilters: options?.dateFilters,
        search: options?.search,
        in: options?.in,
        notEq: options?.notEq,
      });
      const groupCols = toColumnArray(options?.groupBy);
      const sumCols = toColumnArray(options?.sum);
      const avgCols = toColumnArray(options?.avg);
      const minCols = toColumnArray(options?.min);
      const maxCols = toColumnArray(options?.max);
      const distinctCols = toColumnArray(options?.countDistinct);
      const wantCount = options?.count === true;
      const hasAggregate =
        wantCount ||
        sumCols.length > 0 ||
        avgCols.length > 0 ||
        minCols.length > 0 ||
        maxCols.length > 0 ||
        distinctCols.length > 0;
      if (!hasAggregate && groupCols.length === 0) {
        throw new Error('aggregate() requires at least one group column or aggregate function');
      }
      const computeRow = (groupRows, keyValues) => {
        const out = { ...keyValues };
        for (const c of sumCols) out[`sum_${c}`] = groupRows.reduce((s, r) => s + (Number(r[c]) || 0), 0);
        for (const c of avgCols) {
          const nums = groupRows.map((r) => Number(r[c])).filter((n) => !Number.isNaN(n));
          out[`avg_${c}`] = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
        }
        for (const c of minCols) {
          const vals = groupRows.map((r) => r[c]).filter((v) => v != null);
          out[`min_${c}`] = vals.length ? vals.reduce((a, b) => (b < a ? b : a)) : null;
        }
        for (const c of maxCols) {
          const vals = groupRows.map((r) => r[c]).filter((v) => v != null);
          out[`max_${c}`] = vals.length ? vals.reduce((a, b) => (b > a ? b : a)) : null;
        }
        for (const c of distinctCols) {
          out[`countDistinct_${c}`] = new Set(
            groupRows.map((r) => r[c]).filter((v) => v != null).map((v) => String(v)),
          ).size;
        }
        if (wantCount) out.count = groupRows.length;
        return out;
      };
      let resultRows;
      if (groupCols.length === 0) {
        resultRows = [computeRow(rows, {})];
      } else {
        const groups = new Map();
        for (const r of rows) {
          const k = JSON.stringify(groupCols.map((g) => r[g] ?? null));
          let group = groups.get(k);
          if (!group) {
            const key = {};
            for (const g of groupCols) key[g] = r[g] ?? null;
            group = { key, rows: [] };
            groups.set(k, group);
          }
          group.rows.push(r);
        }
        resultRows = [...groups.values()].map((g) => computeRow(g.rows, g.key));
      }
      if (options?.limit != null) {
        resultRows = resultRows.slice(0, Math.max(1, Math.min(1000, options.limit)));
      }
      return resultRows;
    },
  };
}

/** DataService = a Proxy that auto-vivifies an in-memory repo per entity name. */
export function createInMemoryData() {
  const dataService = {};
  return new Proxy(dataService, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (!target[prop]) target[prop] = createInMemoryRepository();
      return target[prop];
    },
  });
}
