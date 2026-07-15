/**
 * Runtime-facing type assertions for catalog helpers (`expectTypeOf`).
 * Negative call-site checks live in `typecheck-fixtures/catalog-typing.ts`
 * (gated by `pnpm typecheck` → check-catalog-translation-types.mjs).
 */
import type { ICUArgs } from 'next-intl';
import { describe, expectTypeOf, it } from 'vitest';

type FixtureMessages = {
  common: {
    save: 'Save';
    hello: 'Hello {name}';
    items: '{count, plural, one {# item} other {# items}}';
  };
};

type Namespace = keyof FixtureMessages & string;

type NestedKeyOf<T> = T extends string
  ? never
  : {
      [K in keyof T & string]: T[K] extends string
        ? K
        : T[K] extends Record<string, unknown>
          ? `${K}.${NestedKeyOf<T[K]>}`
          : K;
    }[keyof T & string];

type NestedValueOf<T, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? NestedValueOf<T[Head], Rest>
    : never
  : Path extends keyof T
    ? T[Path]
    : never;

type MessageKeyOf<N extends Namespace> = NestedKeyOf<FixtureMessages[N]>;

type MessageArgsOf<N extends Namespace, K extends MessageKeyOf<N>> = [K] extends [
  infer Key extends MessageKeyOf<N>,
]
  ? NestedValueOf<FixtureMessages[N], Key> extends infer Value
    ? Value extends string
      ? ICUArgs<
          Value,
          {
            ICUArgument: string;
            ICUNumberArgument: number | bigint;
            ICUDateArgument: Date;
          }
        >
      : never
    : never
  : never;

/** Same rest-tuple rule as generated `i18n/index.ts`. */
type TranslateValuesArgs<Args> = [Args] extends [infer A]
  ? keyof A extends never
    ? []
    : Partial<A> extends A
      ? [values?: A]
      : [values: A]
  : never;

describe('catalog translation typing rules', () => {
  it('derives ICU arg shapes from message strings', () => {
    expectTypeOf<MessageArgsOf<'common', 'save'>>().toEqualTypeOf<Record<string, never>>();
    expectTypeOf<MessageArgsOf<'common', 'hello'>>().toEqualTypeOf<{ name: string }>();
    expectTypeOf<MessageArgsOf<'common', 'items'>>().toEqualTypeOf<{
      count: number | bigint;
    }>();
  });

  it('uses an empty rest tuple when the key has no ICU args', () => {
    expectTypeOf<TranslateValuesArgs<MessageArgsOf<'common', 'save'>>>().toEqualTypeOf<[]>();
  });

  it('requires typed values for ICU placeholders and plurals', () => {
    expectTypeOf<TranslateValuesArgs<MessageArgsOf<'common', 'hello'>>>().toEqualTypeOf<
      [values: { name: string }]
    >();
    expectTypeOf<TranslateValuesArgs<MessageArgsOf<'common', 'items'>>>().toEqualTypeOf<
      [values: { count: number | bigint }]
    >();
  });
});
