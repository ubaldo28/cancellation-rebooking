import { useEffect, useState } from 'react';
import { api, type BookingState } from '../api';
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
 *
 * THE SECOND HALF OF THIS FILE IS THE SAME ARRANGEMENT FOR THE ACCOUNT. The
 * site made the identical mistake there — one sentence per page, every one of
 * them written from the same wrong belief that a customer never signs up — so
 * that correction is kept in one place too, next to the money it is always
 * read beside.
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
  'Paying on the site is not built yet. Pressing Book holds the appointment '
  + 'and takes no money, and no card is asked for until payment is switched '
  + 'on; the business confirms it and arranges the price with you directly. '
  + 'Everything this site says about paying here, about refunds and about '
  + 'cancellation fees is how it is meant to work once payment is switched on. '
  + 'Until then there is nothing to refund and cancelling costs nobody '
  + 'anything.';

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

// ---------------------------------------------------------------------------
// The other half of the same correction: the account
// ---------------------------------------------------------------------------

/**
 * What booking actually requires of a customer, in one sentence.
 *
 * THE MODEL THIS REPLACES WAS WRONG, and this bundle said so in about thirty
 * places: "No account. No app. No card." on the hero, "there is no account to
 * create, here or later" at the checkout, "Do I need an account? No, and there
 * is not one to create" on /help. A customer needs an account and a card to
 * book. What is true — and all that was ever true — is that neither is asked
 * for until they have decided to buy something.
 *
 * SEPARATE FROM PAY_TODAY_SHORT ON PURPOSE, and not because the two describe
 * different moments. PAY_TODAY_SHORT is pinned character for character against
 * src/lib/seo.ts by test/public-payload.test.ts, so the crawler's copy of a
 * page and the React copy of the same URL cannot say different things about
 * money; folding the account into it would break that pin for a reason that
 * has nothing to do with what the pin protects. This constant is the mirror of
 * ACCOUNT_TODAY_SHORT in src/lib/seo.ts and has to stay word for word the same
 * as it, for exactly the reason that one does: /s/<trade> and /cost/<trade>
 * are rendered twice, once by the Worker and once here.
 *
 * The account half is stated as a fact, because it is one and the checkout
 * enforces it today. The card half is stated as the design, because nothing in
 * this product can take a card yet.
 */
export const ACCOUNT_TODAY_SHORT =
  'Booking needs an account, and making one is a text message: you give a '
  + 'mobile number at the moment you book and type the six digits we send '
  + 'back. Looking, comparing prices and messaging a business need no account '
  + 'at all, and neither does opening a booking you already have — the link in '
  + 'your confirmation still works on any phone. A card is needed as well once '
  + 'paying on the site is switched on, which it is not yet.';

/** The heading the account notice wears wherever it is drawn as its own block. */
export const ACCOUNT_TODAY_TITLE = 'What booking needs from you';

/**
 * The account notice, as a block, with this deployment's own answer under it.
 *
 * WHY THIS ASKS THE SERVER RATHER THAN CARRYING THE ANSWER. Whether an account
 * can be created at all depends on whether a text message can be delivered,
 * which is a Worker secret and not something a bundle can know. Today no
 * deployment has an SMS provider configured, so no account can be created and
 * nothing can be booked — and a page that recites the sign-up without saying
 * that is inviting somebody to fill a basket in and meet a 503. The sentence
 * shown is the Worker's own `sms_note`, so the site and the API cannot come to
 * disagree about it; see api.bookingState.
 *
 * A failed request leaves the deployment line off rather than guessing at one.
 * The checkout does not rely on this — Book.tsx reads the same state itself and
 * stops the button — so the worst a failure here costs is one missing sentence
 * on an information page.
 */
export function AccountState({ className }: { className?: string }) {
  const [state, setState] = useState<BookingState | null>(null);

  useEffect(() => {
    let live = true;
    api.bookingState()
      .then((s) => { if (live) setState(s); })
      .catch(() => { /* see above: the deployment line is simply not drawn */ });
    return () => { live = false; };
  }, []);

  return (
    <p className={`pay-state${className ? ` ${className}` : ''}`}>
      <strong>{ACCOUNT_TODAY_TITLE}.</strong>{' '}
      {ACCOUNT_TODAY_SHORT}
      {state && !state.sms_ready && state.sms_note && <>{' '}{state.sms_note}</>}
    </p>
  );
}
