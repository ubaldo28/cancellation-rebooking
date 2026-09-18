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
 * THE TRUTH, from the Worker and not from anybody's intention. A customer pays
 * the full listed price by card at the moment they book, on this site, in
 * Stripe's own embedded form -- src/lib/checkout.ts opens the charge,
 * markPaid confirms it from the signed webhook, and src/lib/fees.ts takes the
 * platform's share out of the business's end and never adds anything to the
 * customer's. The cancellation ladder in src/lib/bypass.ts is live and moves
 * real money, in both directions.
 *
 * SO THE COPY SAYS THAT, EVERYWHERE, IN THESE WORDS. The strings below are the
 * whole of what the site claims about payment; the pages import them rather
 * than each writing their own version, which is the arrangement that failed
 * last time and is why /covered's ladder, Trade.tsx's FAQ and Discover's
 * covered band are all built from single arrays too.
 *
 * THIS FILE WAS ONCE THE OPPOSITE, AND THAT IS THE LESSON. For months every
 * string here said no money moved, no card was asked for and cancelling cost
 * nobody anything -- which was true, and then stopped being true the hour
 * Stripe was switched on, while the sentences stayed. A customer was shown a
 * working card form under a line promising no card could be taken. Copy that
 * describes a switchable state has to be changed in the same commit that
 * throws the switch, and the two-trees and public-payload tests exist to make
 * that impossible to half-do.
 *
 * THE SECOND HALF OF THIS FILE IS THE SAME ARRANGEMENT FOR THE ACCOUNT. The
 * site made the identical mistake there -- one sentence per page, every one of
 * them written from the same wrong belief that a customer never signs up -- so
 * that correction is kept in one place too, next to the money it is always
 * read beside.
 */

/**
 * One sentence. For a FAQ answer, a card body or anywhere the surrounding copy
 * has already raised the subject — including Trade.tsx's structured data,
 * which is why this is a plain string and not markup.
 */
export const PAY_TODAY_SHORT =
  'You pay on this site when you book, by card, and the price you see is the '
  + 'price you pay — nothing is added at checkout. Round The Way holds that '
  + 'payment until the job is done and then pays the business.';

/**
 * The same fact with the consequence spelled out, for the places a reader has
 * arrived specifically to find out how paying works: the checkout, /covered,
 * /help. The second half is the part that stops the cancellation ladder
 * reading as a threat about money that does not exist.
 */
export const PAY_TODAY_LONG =
  'You pay when you book, on this site, by card. The price you see is the '
  + 'price you pay — nothing is added at checkout, and no cash changes hands '
  + 'at the door. Round The Way holds that payment until the job is done and '
  + 'then pays the business, which is what makes a refund possible if it goes '
  + 'wrong. How much comes back if you cancel depends on how close to the '
  + 'appointment you are; the amounts are set out below and they are real.';

/**
 * The business's half of the same fact, for /pros and the business questions
 * on /help. An operator making a decision about their week needs to know that
 * a booking arrives unpaid before they take one, not afterwards.
 */
export const PAY_TODAY_PRO =
  'A booking reaches you already paid for. The customer pays Round The Way at '
  + 'the moment they book, we hold it until the job is done, and your share '
  + 'goes straight to your own bank account. Round The Way keeps 15% of the '
  + 'job, never more than $150 from one business in one day. There is no '
  + 'subscription and nothing is charged to you for using the site.';

/** The heading the notice wears wherever it is drawn as its own block. */
export const PAY_TODAY_TITLE = 'How paying works';

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
 * THEY WENT OUT OF STEP ONCE AND NOTHING FAILED. Migration 0038 moved the
 * sign-in code and the account itself from a mobile number to an email address.
 * This half was updated and the Worker's was not, so for a while the crawler's
 * copy of /s/<trade> and /cost/<trade> told people booking asked for a mobile
 * number while the page they actually landed on asked for an address — and the
 * indexed one was the wrong one, which is the worse half to get wrong.
 *
 * Nothing caught it, because the pin in public-payload.test.ts compares seo.ts
 * against seo.ts's own FAQ payload and never against this file. The pair is now
 * pinned properly in test/two-trees.test.ts, which is where a fact written out
 * once per tree belongs.
 *
 * Both halves are stated as facts, because the checkout enforces both:
 * checkoutCard in src/index.ts refuses an order with 402 card_required when
 * the account has no card, and CardField.tsx is the box the card goes into.
 */
export const ACCOUNT_TODAY_SHORT =
  'Booking needs an account and a card. Making the account is an email: you '
  + 'give an email address at the moment you book and type the six digits we '
  + 'send to it, then add a card on the same screen. Looking, comparing prices '
  + 'and messaging a business need no account at all, and neither does opening '
  + 'a booking you already have — the link in your confirmation still works on '
  + 'any phone.';

/** The heading the account notice wears wherever it is drawn as its own block. */
export const ACCOUNT_TODAY_TITLE = 'What booking needs from you';

/**
 * The account notice, as a block, with this deployment's own answer under it.
 *
 * WHY THIS ASKS THE SERVER RATHER THAN CARRYING THE ANSWER. Whether an account
 * can be created at all depends on whether the sign-in code can be delivered,
 * which is a Worker secret and not something a bundle can know. Today no
 * deployment has an email provider configured, so no code can be sent, no
 * account can be created and nothing can be booked — and a page that recites
 * the sign-up without saying that is inviting somebody to fill a basket in and
 * meet a 503. The sentence shown is the Worker's own `sms_note`, so the site
 * and the API cannot come to disagree about it; see api.bookingState, which
 * also explains why that field and `sms_ready` keep names from the channel this
 * used to travel down.
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
