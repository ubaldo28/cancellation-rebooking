import { formatMoney } from './format';

/**
 * What happened to one customer's money, in the words a person uses.
 *
 * WHY THIS IS A FILE AND NOT A FEW LINES IN A COMPONENT. The same booking is
 * read on two screens — the account list at /account and the conversation at
 * /c/:token — and they are read by the same person about the same money. Two
 * copies of this decision would eventually disagree, and the disagreement a
 * customer notices is the one that matters: a page saying "£240 is coming back"
 * beside a page saying "£240 went back on Tuesday" is a page telling somebody
 * their refund has been sent twice, or not at all.
 *
 * EVERY BRANCH BELOW IS DECIDED BY A FIELD THE WORKER ACTUALLY SENDS. Nothing
 * here works out a refund, a share or a fee; those are the Worker's arithmetic
 * and a number quoted by a browser that disagrees with the money by a cent is a
 * support ticket that costs more than the cent. All this does is choose which
 * true sentence to print.
 *
 * THE ONE DISTINCTION THE WHOLE FILE EXISTS FOR is `refund_cents` against
 * `refunded_at`. The first is what was decided at the cancellation and the
 * second is what was done about it, and for most of this product's life only
 * the first existed — a figure written down, shown to the customer, and never
 * sent anywhere. A screen that reads only `refund_cents` makes a refund that
 * never left look exactly like one that landed, and the first anybody would
 * hear of the difference is a chargeback.
 */

/**
 * The fields this needs off a customer's booking row.
 *
 * Written structurally rather than importing `CustomerBooking`, so the shape
 * this depends on is stated here in full: if the Worker ever stops sending one
 * of these, the failure is a type error on the row rather than a sentence that
 * quietly stops being true.
 */
export interface BookingMoneyRow {
  /** The order's status. 'confirmed' is what markPaid writes when the card clears. */
  status: string;
  currency: string;
  price_cents: number;
  parts_cents: number;
  cancelled_at: number | null;
  cancelled_by: string | null;
  settlement: string;
  refund_cents: number | null;
  refunded_at: number | null;
}

/** Which of the six things this is, for the chip and for choosing a colour. */
export type MoneyTone =
  | 'paid' | 'refunded' | 'coming' | 'held' | 'nothing' | 'unpaid';

export interface MoneyState {
  tone: MoneyTone;
  /** Two or three words, for a chip beside the price. */
  label: string;
  /** The whole of it, in sentences, with the amount and the date written out. */
  says: string;
  /**
   * The parts line, when there are parts. Kept apart from `says` because it is
   * a different charge on a different day and folding the two together is what
   * makes somebody think a refund covers a part it never touched.
   */
  parts: string | null;
}

/**
 * "12 September", in the reader's own time zone.
 *
 * The year is added only when it is not this one. A refund that landed
 * yesterday reading "12 September 2026" looks like a document; the same line
 * for a booking from two winters ago genuinely needs the year, and leaving it
 * off there is how somebody chases a refund that arrived long ago.
 */
export function onDay(seconds: number, locale?: string): string {
  const d = new Date(seconds * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }),
  }).format(d);
}

/**
 * Which of the money states this booking is in, and the sentence for it.
 *
 * `locale` is the reader's, and it is optional for a reason: the account page
 * has nobody's locale to hand and takes the default, while the conversation
 * page already prints the price in the business's locale a few lines above
 * this, so it passes that one through and the two amounts on one card match.
 * `currency` always comes off the row — it is the currency the job was priced
 * in and has nothing to do with who is reading.
 */
export function bookingMoney(b: BookingMoneyRow, locale?: string): MoneyState {
  const amount = (cents: number) => formatMoney(cents, b.currency, locale);
  const refund = b.refund_cents ?? 0;

  // Parts are a second charge taken on the day the customer tapped approve,
  // and the refund ladder never touches them: refundFor in src/lib/bypass.ts
  // works from the price of the appointment alone. Saying so is the difference
  // between an honest cancellation and one somebody expects more back from.
  const parts = b.parts_cents > 0
    ? `The ${amount(b.parts_cents)} of parts you approved was charged on the day, `
      + 'separately from the appointment.'
    : null;

  if (b.cancelled_at == null) {
    // Nothing was cancelled, so the only question is whether the card cleared.
    // markPaid sets the order to 'confirmed' in the same statement it writes
    // paid_at, so this really is the paid state and not a guess at one.
    if (b.status === 'confirmed') {
      return {
        tone: 'paid',
        label: 'Paid',
        says: `You paid ${amount(b.price_cents)} by card when you booked. Round The `
          + 'Way is holding it and pays the business after the job is done.',
        parts,
      };
    }
    if (b.status === 'failed') {
      return {
        tone: 'unpaid',
        label: 'Payment failed',
        says: 'Your card was refused, so nothing has been taken and this is not '
          + 'booked. Message the business if you still want the slot.',
        parts,
      };
    }
    if (b.status === 'pending') {
      // The charge has been opened and the webhook confirming it has not
      // arrived. Almost always seconds, occasionally longer, and saying "paid"
      // here would be claiming money that may yet be refused.
      return {
        tone: 'unpaid',
        label: 'Paying',
        says: `${amount(b.price_cents)} is going through on your card now. It is not `
          + 'settled until your bank answers, which is usually a few seconds.',
        parts,
      };
    }
    // Any other status on a booking nothing has cancelled is one this bundle
    // has not heard of, and the wrong thing to do with an unfamiliar payment
    // state is to pick the nearest familiar one and print that. Say the price,
    // which is certainly true, and send them to somebody who can look.
    return {
      tone: 'unpaid',
      label: 'Ask about this one',
      says: `${amount(b.price_cents)} is the price of this booking. We cannot say `
        + 'from here what has happened to the payment — open the booking from the '
        + 'link in your confirmation and ask the business.',
      parts,
    };
  }

  // Who cancelled changes nothing about the money — the ladder and the freeze
  // are the same either way — but it is the first thing the reader wants to
  // know, and a sentence that starts "This was cancelled" by nobody in
  // particular reads as something the site did to them.
  const who = b.cancelled_by === 'operator' ? 'The business cancelled this' : 'You cancelled this';

  // Done. This is the only branch that may say money has moved, because
  // refunded_at is the only field that means it did.
  if (b.refunded_at != null && refund > 0) {
    return {
      tone: 'refunded',
      label: 'Refunded',
      says: `${who}. ${amount(refund)} went back to your card on `
        + `${onDay(b.refunded_at, locale)}. Refunds take a few days to appear on a `
        + 'statement, so look for it on the card you paid with rather than as a '
        + 'new payment in.',
      parts,
    };
  }

  // Frozen. Both sides of a cancelled booking are held until somebody says
  // whether the work happened anyway — see src/lib/settlement.ts — and this is
  // the state where telling somebody their refund is on its way would be
  // straightforwardly false.
  //
  // WHO IS BEING ASKED DEPENDS ON WHO CANCELLED, and the two are not the same
  // sentence. Only a business's cancellation puts a question on the customer's
  // booking; when the customer cancelled there is nothing for them to answer
  // and the hold simply runs out, so telling them to go and answer something
  // would send them looking for a button that is not there.
  if (b.settlement === 'held') {
    const held = b.cancelled_by === 'operator'
      ? 'we are waiting to hear whether the work happened anyway, and answering '
        + 'that question on your booking is what releases it.'
      : 'it is held for a short while after the time you were booked for, in case '
        + 'the job went ahead regardless, and then it goes back on its own.';
    return {
      tone: 'held',
      label: 'On hold',
      says: refund > 0
        ? `${who}. ${amount(refund)} is set aside to come back to you and nothing has `
          + `moved yet: ${held}`
        : `${who}. Nothing has moved yet: ${held}`,
      parts,
    };
  }

  // Decided and not yet done. The Worker retries this every quarter of an hour
  // until the money is out, so "coming" is a promise the product keeps rather
  // than an estimate — but it is deliberately not dated, because nothing here
  // knows when the next attempt will land.
  if (refund > 0) {
    return {
      tone: 'coming',
      label: 'Refund on its way',
      says: `${who}, and you get ${amount(refund)} back. It has not reached your card `
        + 'yet — when it does, the date it went shows here.',
      parts,
    };
  }

  // Nothing owed. Either the ladder reached the bottom, or the work was
  // recorded as having happened anyway and the payment stayed with the
  // business. Both are "nothing comes back", and neither is worth dressing up.
  return {
    tone: 'nothing',
    label: 'Cancelled',
    says: `${who}, and nothing comes back on this one.`,
    parts,
  };
}
