/**
 * Compile-time regression for catalog `useTranslations` typing rules
 * (mirrors helpers emitted into `i18n/keys.ts` + `i18n/index.ts`).
 *
 * Outside package `src/` (Biome + build ignore this folder);
 * checked by scripts/check-catalog-translation-types.mjs.
 * Must typecheck clean: positive calls are valid; negatives use @ts-expect-error.
 */
import type { ICUArgs } from 'next-intl';

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

type TranslateValuesArgs<Args> = [Args] extends [infer A]
  ? keyof A extends never
    ? []
    : Partial<A> extends A
      ? [values?: A]
      : [values: A]
  : never;

type TranslationsFor<N extends Namespace> = <K extends MessageKeyOf<N>>(
  key: K,
  ...args: TranslateValuesArgs<MessageArgsOf<N, K>>
) => string;

declare const t: TranslationsFor<'common'>;

// ── Positive (must accept) ──────────────────────────────────────────────
t('save');
t('hello', { name: 'Ada' });
t('items', { count: 2 });
t('items', { count: 2n });

// ── Negative (must reject; unused @ts-expect-error = rule regression) ───
// @ts-expect-error plain keys reject a values argument
t('save', { name: 'x' });

// @ts-expect-error plural requires values
t('items');

// @ts-expect-error count must be number | bigint
t('items', { count: '2' });

// @ts-expect-error placeholder requires values
t('hello');

// @ts-expect-error name must be string
t('hello', { name: 1 });

// @ts-expect-error unknown key
t('missing');

// @ts-expect-error unknown nested key
t('nav.home');
