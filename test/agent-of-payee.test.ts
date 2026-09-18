import { describe, expect, it } from 'vitest';
import { clientSource } from './client-source';

/**
 * The clause that keeps this product out of money transmission.
 *
 * Handing a customer's money to somebody else is money transmission, and doing
 * it in California without a licence from the Department of Financial
 * Protection and Innovation is illegal. The way a marketplace avoids needing
 * that licence is the agent-of-payee exemption, and it turns on two facts that
 * live entirely in the terms:
 *
 *   1. The marketplace collects as the BUSINESS'S AGENT, under a written
 *      agreement the business accepted BEFORE the money moved.
 *   2. The customer's debt to the business is DISCHARGED the instant the
 *      customer pays the marketplace — the business cannot come back to the
 *      customer for it.
 *
 * Neither can be added after the fact. A payment already collected without
 * them was collected without the exemption, and no later edit to this page
 * changes what happened to that payment. So the clause has to be here before
 * payments are switched on, and it has to stay.
 *
 * That makes it exactly the kind of text a future tidy-up deletes for reading
 * like boilerplate. This test is the reason it cannot.
 */
describe('agent-of-payee clause', () => {
  const terms = clientSource('web/src/pages/Terms.tsx');

  /** Wording changes; these facts may not disappear from the page. */
  const required: Array<[string, RegExp]> = [
    [
      'the site collects as the business’s agent',
      /as the business's appointed\s+agent/,
    ],
    [
      'paying the site settles what the customer owes the business',
      /settles the customer's obligation to the business in full/,
    ],
    [
      'the business cannot pursue the customer for money the site holds',
      /no claim against the customer for the same money/,
    ],
    [
      'the business appoints the site as its agent by listing',
      /appoints Round The Way as its agent to receive\s+payment/,
    ],
    [
      'that appointment predates any payment',
      /before any opening can be\s+listed and so before any payment can be taken/,
    ],
  ];

  for (const [fact, pattern] of required) {
    it(`states that ${fact}`, () => {
      expect(terms).toMatch(pattern);
    });
  }

  it('puts the appointment in the section the payment clause cites', () => {
    // The payment clause points the reader at section 7 for the agreement it
    // relies on. If the appointment ever moves out of section 7, that link
    // becomes a citation to nothing and the clause stops being self-evidencing.
    // Anchored on the headings themselves, not on the words: both titles also
    // appear up in the table of contents, and slicing from the first match
    // would measure the contents list rather than the section.
    const seven = terms.slice(
      terms.indexOf('<h2 id="t-listing">'),
      terms.indexOf('<h2 id="t-messages">'),
    );
    expect(seven).not.toBe('');
    expect(seven).toMatch(/appoints Round The Way as its agent/);
    expect(terms).toMatch(/href="#t-listing">section 7<\/a>/);
  });
});
