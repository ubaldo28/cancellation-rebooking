import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

/**
 * Reading the browser's half of a duplicated fact.
 *
 * Several constants and sentences exist twice on purpose: the Worker cannot
 * import a .tsx file compiled for the browser, and the browser bundle does not
 * carry the Worker's modules. Where the two halves have to agree, a test reads
 * the client's copy off disk and compares it against the Worker's — so the
 * duplication is legal but not silent, and changing one side fails.
 *
 * Everything here is a reader. Nothing in this file knows what any particular
 * constant means; the tests that use it do.
 */

/** A file in this repository, by its path from the repository root. */
export const clientSource = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * The value of a string constant declared as `const NAME = 'a' + 'b';`.
 *
 * The pieces are joined because the house style wraps long sentences across
 * several quoted fragments, and it is the finished sentence that has to match.
 * A declaration that has moved or been renamed fails here with that as the
 * message rather than as an inscrutable comparison against undefined.
 */
export function exportedString(source: string, name: string): string {
  const decl = source.match(new RegExp(`const ${name}\\s*=([\\s\\S]*?);`));
  if (!decl) throw new Error(`${name} is no longer declared where this test looks for it`);
  const parts = [...decl[1]!.matchAll(/'((?:[^'\\]|\\.)*)'/g)]
    .map((m) => m[1]!.replace(/\\(['\\])/g, '$1'));
  if (parts.length === 0) throw new Error(`${name} is declared but holds no string literal`);
  return parts.join('');
}

/** The value of a numeric constant declared as `const NAME = 1234;` or `12_00`. */
export function exportedNumber(source: string, name: string): number {
  const m = source.match(new RegExp(`const ${name}\\s*=\\s*([0-9_]+)\\s*;`));
  if (!m) throw new Error(`${name} is no longer declared where this test looks for it`);
  return Number(m[1]!.replace(/_/g, ''));
}

/**
 * A run of declarations lifted out of a browser file and made callable here.
 *
 * `from` and `to` are literal fragments marking the first and last line of the
 * region, which must be self-contained: it may not reference an import, only
 * itself and the globals every runtime has. The region is compiled by esbuild
 * rather than by a regex that strips type annotations, so what runs is what
 * TypeScript would have emitted and a test cannot pass by mis-parsing the
 * source it is meant to be checking.
 *
 * This is how a duplicated CALCULATION is pinned rather than merely a
 * duplicated number: the browser's arithmetic is executed against the same
 * inputs as the Worker's and the two answers are compared.
 */
export function liftFunction<T = (...args: any[]) => any>(
  source: string, from: string, to: string, name: string,
): T {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`region no longer starts with: ${from}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`region no longer ends with: ${to}`);
  const region = source.slice(start, end + to.length);
  const js = transformSync(region, { loader: 'ts' }).code;
  // eslint-disable-next-line no-new-func
  return new Function(`${js}\nreturn ${name};`)() as T;
}
