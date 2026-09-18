import { describe, expect, it } from 'vitest';
import { clientSource } from './client-source';

/**
 * Every help question sits in exactly one topic.
 *
 * The help centre groups its questions by topic, and it does it by NAMING
 * them: the answers stay in CUSTOMER and BUSINESS, and CUSTOMER_TOPICS and
 * BUSINESS_TOPICS list which question goes where. That keeps the three
 * hundred lines of answers untouched, and it introduces exactly one way to
 * get it wrong — a question whose text is edited in one array and not the
 * other, which silently drops it off the page with no error anywhere.
 *
 * `pick` filters out anything it cannot resolve, so a mistyped title is not a
 * crash; it is a question that quietly stops existing. This is the test that
 * makes that impossible.
 */
describe('help centre topics', () => {
  const src = clientSource('web/src/pages/Help.tsx');

  /** The `q:` titles of one array, in order. */
  function questions(name: string): string[] {
    const start = src.indexOf(`const ${name}: QA[]`);
    expect(start, `${name} has moved`).toBeGreaterThan(-1);
    const end = src.indexOf('\n];', start);
    return [...src.slice(start, end).matchAll(/^ {4}q: '((?:[^'\\]|\\.)*)',$/gm)]
      .map((m) => m[1]!.replace(/\\'/g, "'"));
  }

  /** Every question named across one topic list, in order. */
  function topicQuestions(name: string): string[] {
    const start = src.indexOf(`const ${name}: Array<`);
    expect(start, `${name} has moved`).toBeGreaterThan(-1);
    const end = src.indexOf('\n];', start);
    return [...src.slice(start, end).matchAll(/^ {6}'((?:[^'\\]|\\.)*)',$/gm)]
      .map((m) => m[1]!.replace(/\\'/g, "'"));
  }

  const pairs: Array<[string, string]> = [
    ['CUSTOMER', 'CUSTOMER_TOPICS'],
    ['BUSINESS', 'BUSINESS_TOPICS'],
  ];

  for (const [arr, topics] of pairs) {
    it(`${arr}: every question is filed, and none is invented`, () => {
      const asked = questions(arr);
      const filed = topicQuestions(topics);

      // Guards the comparison: two empty lists are also equal.
      expect(asked.length).toBeGreaterThan(8);

      const missing = asked.filter((q) => !filed.includes(q));
      expect(missing, `${arr} questions that no topic claims`).toEqual([]);

      const unknown = filed.filter((q) => !asked.includes(q));
      expect(unknown, `${topics} names questions that do not exist`).toEqual([]);
    });

    it(`${arr}: no question is filed under two topics`, () => {
      const filed = topicQuestions(topics);
      const seen = new Set<string>();
      const twice = filed.filter((q) => (seen.has(q) ? true : (seen.add(q), false)));
      expect(twice).toEqual([]);
    });
  }

  it('keeps the search, the audience switch and the closing band', () => {
    // The three things that make this a help centre rather than a list.
    expect(src).toContain('placeholder="Search help"');
    expect(src).toContain('Help for customers');
    expect(src).toContain('Help for pros');
    expect(src).toContain('Still need help?');
    // And the promise it must not make.
    expect(src).toContain('no support phone line and no support mailbox');
  });
});
