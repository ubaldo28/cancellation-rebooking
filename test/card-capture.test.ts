import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CARD_CAPTURE_SHIPPED } from '../src/lib/payments';

/**
 * THE PROMISE CARD_CAPTURE_SHIPPED MAKES, KEPT BY A TEST.
 *
 * There was an outage. checkoutCard refused every booking on the site with
 * 402 card_required the moment the Stripe webhook secret was set, because the
 * refusal was wired to "can money move" and nothing else. There was no card
 * field anywhere for a customer, so the requirement could not be satisfied by
 * anybody, and setting one Worker secret — a step with no visible relationship
 * to booking — quietly stopped the product working.
 *
 * The fix was to make the gate need two things: money can move AND there is
 * somewhere to type a card. That only helps if the second half stays true, and
 * a boolean constant is exactly the kind of thing that gets flipped on in
 * advance "ready for when the form lands".
 *
 * So these tests tie the constant to the actual form. They read the front-end
 * source rather than rendering it, which is crude on purpose: the question is
 * not whether the component behaves, it is whether the component EXISTS and is
 * reachable by a customer at checkout. A crude check that cannot be fooled by
 * a mock is the right instrument for that.
 */
const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('a customer card can actually be given before it is demanded', () => {
  it('has a card field component when the flag says one has shipped', () => {
    if (!CARD_CAPTURE_SHIPPED) return;
    const src = read('web/src/components/CardField.tsx');
    // Setup mode, not a charge: a card on file is stored, not billed, and
    // confirmPayment here would take money at the wrong moment.
    expect(src).toMatch(/confirmSetup/);
    // The whole point of embedding: the customer never leaves this site.
    expect(src).toMatch(/redirect:\s*'if_required'/);
  });

  it('renders that field on the booking page', () => {
    if (!CARD_CAPTURE_SHIPPED) return;
    const book = read('web/src/pages/Book.tsx');
    expect(book).toMatch(/import CardField from/);
    // Drawn, not merely imported. An import with no JSX is how this check
    // would pass while a customer still saw no card field.
    expect(book).toMatch(/<CardField/);
    // And the booking button must wait for it, or the page sends an order the
    // Worker is going to refuse.
    expect(book).toMatch(/!needsCard/);
  });

  it('sends the card with the order rather than hoping a later screen asks', () => {
    if (!CARD_CAPTURE_SHIPPED) return;
    expect(read('web/src/pages/Book.tsx')).toMatch(/card_ref:/);
  });

  it('has a route the field can open a setup against', () => {
    if (!CARD_CAPTURE_SHIPPED) return;
    const worker = read('src/index.ts');
    expect(worker).toMatch(/'\/api\/public\/setup-intent'/);
    expect(read('web/src/api.ts')).toMatch(/setup-intent/);
  });
});
