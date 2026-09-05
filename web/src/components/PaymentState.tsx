import '../styles-payment.css';

/**
 * What actually happens to money when somebody presses Book, said once.
 *
 * WHY THIS FILE EXISTS. The site was telling two different stories at the same
 * time. The checkout in Book.tsx said "Payment is not switched on yet ... this
 * button holds the appointments and takes no money", and four inches above it
 * the terms box said "Your card is charged for the appointment when you book".
 * /covered opened with "You pay for the labour when you book, on this site",
 * /help answered "When do I pay?" the same way, the trade FAQ said it a third
 * time and the front page's covered band said it a fourth. A visitor who read
 * any two of them had been told something untrue by at least one.
 *
 * THE TRUTH, from the Worker and not from anybody's intention. Every place
 * money would move is an unimplemented seam, and each one is marked as one in
 * the code: createOrder in src/lib/orders.ts writes orders.status 'pending' and
 * says in as many words that no money has moved; the refund and the operator
 * fee in src/lib/bypass.ts, the parts charge in src/lib/parts.ts, the estimate
 * that becomes a booking in src/lib/estimates.ts and the settlement in
 * src/lib/settlement.ts are all the same. Nothing on this site takes a card
 * from a customer, holds a balance, or pays anybody out.
 *
 * SO THE COPY SAYS THAT, EVERYWHERE, IN THESE WORDS. The strings below are the
 * whole of what the site claims about payment; the pages import them rather
 * than each writing their own version, which is the arrangement that failed
 * last time and is why /covered's ladder, Trade.tsx's FAQ and Discover's
 * covered band are all built from single arrays too.
 *
 * WHAT IS NOT BEING DELETED. The cancellation ladder, the parts-approval rule
 * and the fee floor are real: they are the design, they are computed by code
 * that exists, and a customer is entitled to know them before they book. They
 * are kept and labelled as the rules that take effect when payment does, which
 * is different from a page reciting them as though money were already at
 * stake. When the seam lands, these strings change and every surface changes
 * with them.
 */

/**
 * One sentence. For a FAQ answer, a card body or anywhere the surrounding copy
 * has already raised the subject — including Trade.tsx's structured data,
 * which is why this is a plain string and not markup.
 */
export const PAY_TODAY_SHORT =
  'Nothing is paid on this site yet. Booking holds the appointment, asks for '
  + 'no card and takes no money, and you settle the price with the business '
  + 'directly.';

/**
 * The same fact with the consequence spelled out, for the places a reader has
 * arrived specifically to find out how paying works: the checkout, /covered,
 * /help. The second half is the part that stops the cancellation ladder
 * reading as a threat about money that does not exist.
 */
export const PAY_TODAY_LONG =
  'Paying on the site is not built yet. Pressing Book holds the appointment, '
  + 'asks for no card details and takes no money; the business confirms it and '
  + 'arranges the price with you directly. Everything this site says about '
  + 'paying here, about refunds and about cancellation fees is how it is meant '
  + 'to work once payment is switched on. Until then there is nothing to '
  + 'refund and cancelling costs nobody anything.';

/**
 * The business's half of the same fact, for /pros and the business questions
 * on /help. An operator making a decision about their week needs to know that
 * a booking arrives unpaid before they take one, not afterwards.
 */
export const PAY_TODAY_PRO =
  'No money moves through Slotfill yet. Payment is not built, so a booking '
  + 'reaches you unpaid and you arrange the price with the customer yourself. '
  + 'Nothing is charged to your card, no fee is collected and there is no '
  + 'payout — everything below about being paid through the site, about fees '
  + 'and about parts charges is how it will work once payment is switched on.';

/** The heading the notice wears wherever it is drawn as its own block. */
export const PAY_TODAY_TITLE = 'Nobody is charged anything today';

/**
 * The notice, as a block.
 *
 * `className` is how a page fits it to its own sheet — `.book-pay` at the
 * checkout, nothing at all on the info pages — because this is one paragraph
 * of running copy rather than a component with a look of its own, and giving
 * it a boxed treatment that competed with each page's own callout style was
 * worse than letting the page decide.
 */
export default function PaymentState(
  { audience = 'customer', className }: {
    audience?: 'customer' | 'pro';
    className?: string;
  },
) {
  return (
    <p className={`pay-state${className ? ` ${className}` : ''}`}>
      <strong>{PAY_TODAY_TITLE}.</strong>{' '}
      {audience === 'pro' ? PAY_TODAY_PRO : PAY_TODAY_LONG}
    </p>
  );
}
