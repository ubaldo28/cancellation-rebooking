/**
 * Keeping contact details out of the conversation.
 *
 * The promise since migration 0011 has been "no number exchange, no SMS", and
 * until now it was kept by not building an SMS path — which is not the same
 * thing as keeping it. Two people typing into a free text box can hand over a
 * phone number in four seconds, and every booking after the first one then
 * happens somewhere this product cannot see, moderate or stand behind.
 *
 * So a message carrying a phone number, an email address, a payment-app handle
 * or an outside link is stored with that detail already removed. Removed, not
 * rejected: bouncing the message back teaches people to try again in a form
 * that gets through, and it punishes the many customers who type their number
 * out of pure habit at the end of a sentence.
 *
 * WHAT THIS IS NOT: it is not unbeatable, and nothing that reads free text
 * ever is. Somebody determined enough will spell a number in words, or split
 * it over three messages, or photograph it. This raises the effort from four
 * seconds to deliberate evasion, and it flags every attempt so the deliberate
 * ones become visible — see threads.redacted_count. That is the achievable
 * goal; treating it as a sealed wall would be the mistake.
 */

import type { Env } from '../types';
import { sha256 } from './util';

export interface Redaction {
  /** The message as it will be stored — already cleaned. */
  body: string;
  /** True when anything was taken out. Drives the flag and the counter. */
  redacted: boolean;
  /** What kinds of thing were removed, for the notice shown to the sender. */
  kinds: string[];
}

/** Shown to whoever sent it, so a redaction never looks like a delivery failure. */
export const REDACTION_NOTICE =
  'Contact details are removed from messages. Keep everything here and you are '
  + 'covered if anything goes wrong — off the app, neither of you is.';

const MASK = '[removed]';

/**
 * Digits that make up a phone number, allowing for the ways people break them
 * up: spaces, dots, dashes, brackets, and the "call me on" flourish.
 *
 * Requires SEVEN or more digits in the run. That number is the whole design of
 * this pattern: six would eat "$1,250.00" and every date somebody writes as
 * 3/14/2026, and a filter that mangles ordinary sentences gets switched off.
 * Seven is the shortest real phone number and long enough that ordinary text
 * does not reach it by accident.
 */
// The leading \(? is not decoration: without it "(818) 555 0199" starts
// matching at the 8 and leaves a naked "(" behind, which looks like a bug to
// the person who typed it and invites them to try again another way.
const PHONE = /(?:\+?\(?\d[\d\s().\-]{5,}\d)/g;

/**
 * The digit count the comment above always claimed and the pattern never
 * enforced.
 *
 * `[\d\s().\-]{5,}` counts CHARACTERS, not digits, so "1500.00" — seven
 * characters and six digits — was masked as a phone number, and an operator
 * quoting a price in the chat watched it disappear. A filter that eats prices
 * is a filter somebody demands be turned off, which is a far worse outcome
 * than the number it was protecting. Counting digits here makes the code do
 * what the comment says.
 */
const hasSevenDigits = (run: string): boolean => (run.match(/\d/g) ?? []).length >= 7;

/** Standard enough. Deliberately loose on the TLD — nobody types a fake one to evade. */
const EMAIL = /[A-Za-z0-9._%+\-]+\s?(?:@|\(at\)|\[at\]|\sat\s)\s?[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/gi;

/**
 * The same address with the punctuation spelled out: "rosa at gmail dot com".
 *
 * This is not an exotic evasion, it is the ordinary way people write an email
 * address when they suspect something is watching — and it went straight
 * through, because EMAIL needs a literal dot before the TLD. The "at" half was
 * already handled; the "dot" half was not, which made the whole pattern one
 * word away from useless.
 *
 * A SPELLED dot is required, not merely any separator, and the last part has
 * to be letters. Accepting a literal full stop here as well would make
 * "I'll be at yours. Thanks" an email address, and a filter that deletes the
 * end of ordinary sentences does more damage than the address it caught —
 * besides which, the version with a real dot in it is what EMAIL above is for.
 */
const DOT = '(?:\\(dot\\)|\\[dot\\]|\\bdot\\b)';
const SPELLED_EMAIL = new RegExp(
  `[A-Za-z0-9._%+\\-]+\\s*(?:@|\\(at\\)|\\[at\\]|\\bat\\b)\\s*[A-Za-z0-9\\-]+`
  + `(?:\\s*${DOT}\\s*[A-Za-z0-9\\-]+)*\\s*${DOT}\\s*[A-Za-z]{2,}`,
  'gi',
);

/**
 * A phone number typed with letters standing in for digits: "8I8 555 O199".
 *
 * Capital i for one, capital o for zero, lower-case L for one. A person doing
 * this is not typing carelessly, they are deliberately getting a number past
 * the filter — which is exactly the case worth catching, and the one the plain
 * digit pattern is blind to.
 *
 * The candidate pattern is deliberately loose and the decision is made in code
 * below, because the three conditions that matter — seven or more characters,
 * at least five real digits, at least one stand-in — read as arithmetic and
 * would be an unreadable lookahead. Those bounds keep ordinary words out:
 * "OIL" has no digits, and "500000" has no stand-in so PHONE already had it.
 */
const HOMOGLYPH_CANDIDATE = /\b[\dOoIlSs][\dOoIlSs \-().]{5,}[\dOoIlSs]\b/g;

/** True when a candidate run is a phone number wearing letters. */
function isHomoglyphPhone(run: string): boolean {
  const core = run.replace(/[^0-9OoIlSs]/g, '');
  const digits = (core.match(/\d/g) ?? []).length;
  const standIns = (core.match(/[OoIlSs]/g) ?? []).length;
  return core.length >= 7 && digits >= 5 && standIns >= 1;
}

/**
 * A phone number written out in words: "eight one eight five five five...".
 *
 * The one evasion the original comment named as beyond reach, and it turns out
 * not to be: seven or more number words in a row is not a sentence anybody
 * writes by accident. "oh" and "o" are included because that is how people say
 * a zero out loud, and "double" because "double five" is how they say two.
 *
 * Seven is the same threshold the digit pattern uses, for the same reason.
 */
const NUMBER_WORD =
  '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|oh|o|double|triple|nought)';
const SPOKEN_PHONE = new RegExp(`\\b(?:${NUMBER_WORD}[\\s.,\\-]+){6,}${NUMBER_WORD}\\b`, 'gi');

/**
 * Digits that are not ASCII digits.
 *
 * Full-width ０-９ and Arabic-Indic ٠-٩ render as a phone number and match none
 * of the patterns above, which makes a keyboard switch a complete bypass. They
 * are folded to ASCII before anything else runs, so the message is stored with
 * ordinary digits and the filter sees what a reader sees.
 */
const CONFUSABLE_DIGITS: Array<[RegExp, number]> = [
  [/[０-９]/g, 0xFF10],   // full-width
  [/[٠-٩]/g, 0x0660],   // Arabic-Indic
  [/[۰-۹]/g, 0x06F0],   // extended Arabic-Indic
  [/[०-९]/g, 0x0966],   // Devanagari
];

function foldDigits(s: string): string {
  let out = s;
  for (const [re, base] of CONFUSABLE_DIGITS) {
    out = out.replace(re, (c) => String(c.charCodeAt(0) - base));
  }
  return out;
}

/** Any outside link. The app has no reason to send anyone anywhere else. */
const URL = /\b(?:https?:\/\/|www\.)[^\s]+/gi;

/**
 * Payment apps and social handles, by name.
 *
 * These are here because the fee in migration 0022 only bites when an operator
 * cancels a booking they already drove to. "Just Venmo me and I'll cancel it
 * as a no-show" routes around that entirely, and it is the single most likely
 * sentence anybody types in this box. Naming the apps is crude and it works:
 * the sentence stops being writable in one go.
 */
// The mail providers are here for the same reason the payment apps are: "just
// email me, it's rosa at gmail" is the sentence, and by the time the address
// itself is broken up enough to slip past EMAIL the provider name is the only
// part of it left to notice.
const HANDLES =
  /\b(?:venmo|cash\s?app|cashapp|\$cashtag|zelle|paypal|wise|revolut|whats\s?app|whatsapp|telegram|signal|imessage|insta(?:gram)?|snap(?:chat)?|facebook|messenger|tiktok|gmail|hotmail|outlook\.?com|yahoo|icloud|protonmail)\b/gi;

/** An @handle, but not an email (those are caught first and already masked). */
const AT_HANDLE = /(?:^|\s)@[A-Za-z0-9._]{2,}/g;

/**
 * Cleans one message body.
 *
 * Order matters and is not arbitrary: emails are masked before phone numbers,
 * because an email containing digits would otherwise be half-eaten by the
 * phone pattern and the remaining half would still be readable. Links go
 * before handles for the same reason.
 */
export function redactContact(raw: string): Redaction {
  // Before anything else, so a keyboard switch is not a complete bypass.
  let body = foldDigits(raw);
  const kinds: string[] = [];

  const pass = (re: RegExp, kind: string, keep?: (m: string) => boolean) => {
    let hit = false;
    body = body.replace(re, (m) => {
      if (keep && !keep(m)) return m;
      // Preserve a leading space so "call me @bob" does not become "call me[removed]".
      const lead = /^\s/.test(m) ? m[0] : '';
      hit = true;
      return lead + MASK;
    });
    if (hit && !kinds.includes(kind)) kinds.push(kind);
  };

  pass(EMAIL, 'an email address');
  // After EMAIL, which handles the ordinary form: what is left for this one is
  // the spelled-out "gmail dot com" version the literal-dot pattern misses.
  pass(SPELLED_EMAIL, 'an email address');
  pass(URL, 'a link');
  pass(PHONE, 'a phone number', hasSevenDigits);
  pass(HOMOGLYPH_CANDIDATE, 'a phone number', isHomoglyphPhone);
  pass(SPOKEN_PHONE, 'a phone number');
  pass(AT_HANDLE, 'a handle');
  pass(HANDLES, 'an off-app contact');

  // Collapse runs the masking can create — "[removed] [removed] [removed]" is
  // noise, and one mask reads as one thing removed, which it effectively is.
  body = body.replace(/(?:\[removed\][\s,.\-]*){2,}/g, `${MASK} `).trim();

  return { body, redacted: kinds.length > 0, kinds };
}

/**
 * What the sender is told when something was taken out.
 *
 * Names the kind, because "your message was edited" with no explanation is how
 * a customer decides the app is broken and asks for a number instead.
 */
export function redactionMessage(r: Redaction): string | null {
  if (!r.redacted) return null;
  const list = r.kinds.length === 1
    ? r.kinds[0]!
    : `${r.kinds.slice(0, -1).join(', ')} and ${r.kinds[r.kinds.length - 1]}`;
  return `We took ${list} out of that message. ${REDACTION_NOTICE}`;
}

/**
 * A first name, out of whatever was typed into a box asking for one.
 *
 * The checkout asked for "Your name" in a single free-text box and stored the
 * answer whole, so a customer who typed "Jane Smith" — which is what most
 * people type when a form says "your name" — handed the business a surname.
 * maskClientRow below deletes last_name and says why: a full name beside a
 * street address is enough to find somebody's landline, their electoral roll
 * entry and their employer. One box undid all of it, and the box was on the
 * busiest form in the product.
 *
 * WHAT ENFORCEMENT CAN HONESTLY MEAN HERE. Nothing can look at free text and
 * tell a first name from a surname: "Marie Claire" may be one person's given
 * name and "Ana Maria" may be two. What is decidable is how much of it we
 * asked for, and we asked for one name. So the first word is kept and the rest
 * is never written down — the obvious case is stopped, and the case that is
 * not obvious cannot be stored either way.
 *
 * Dropped rather than refused, for the reason redactContact gives above:
 * bouncing "Jane Smith" back at somebody mid-checkout teaches them to try a
 * spelling that gets through, and punishes the many people who typed their
 * full name out of habit. The field's own help text is what tells them why
 * only the first name is wanted; this is what makes that true regardless of
 * which client, or which script, is filling the form in.
 */
export function firstNameOnly(raw: string | null | undefined): string {
  // Split on any whitespace, so a name pasted with a newline or a tab in it is
  // cut at the same place a space would cut it.
  const first = (raw ?? '').trim().split(/\s+/)[0] ?? '';
  // "Smith, Jane" leaves a trailing comma on the word that is kept. The comma
  // is punctuation the person did not mean to be part of their name, and a
  // stored "Smith," reads to the operator as a typo we made.
  return first.replace(/[,;]+$/, '');
}

/**
 * The customer's phone number, as the operator is allowed to see it.
 *
 * Never the number. The operator has no reason to hold it: they are not
 * texting the customer, the app carries the messages, and a number handed over
 * once is handed over forever. The last two digits are kept only so the
 * operator can tell two bookings apart on a busy day.
 *
 * This applies to customers the PLATFORM introduced. An operator's own
 * imported client list is theirs — they typed those numbers in and nothing
 * here touches them.
 */
export function maskPhone(e164: string | null | undefined): string | null {
  const s = (e164 ?? '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `•••• ${digits.slice(-2)}`;
}

/**
 * The customer's number, as `public_claims` is allowed to hold it.
 *
 * That table is scoped by operator_id and until migration 0035 it stored the
 * number and the mailbox in full. Nothing read them — every query against it
 * is an EXISTS or a COUNT — which made it harmless right up until the first
 * `SELECT *` somebody writes for a dashboard, and then it is the whole promise
 * gone in one query nobody would think twice about.
 *
 * Erasure is why a column is kept at all rather than the lot being dropped: it
 * finds every claim one person ever made by their number, and an erasure that
 * reaches one of somebody's three bookings has not erased them. A digest
 * answers that lookup exactly as the number did — hash the number being erased
 * and compare — while being nothing anybody can dial.
 *
 * Peppered with SESSION_PEPPER, the same way retention.ts hashes an erasure
 * subject and auth.ts hashes a token, because an unpeppered hash of a phone
 * number is not a secret: the whole space of valid numbers is small enough to
 * enumerate on a laptop, so a stolen table would be a stolen contact list.
 */
export const claimPhoneHash = (env: Env, e164: string): Promise<string> =>
  sha256(`${e164}:${env.SESSION_PEPPER}`);

/** The same, for an email. The domain goes too — it is often the person's name. */
export function maskEmail(email: string | null | undefined): string | null {
  const s = (email ?? '').trim();
  if (!s || !s.includes('@')) return null;
  return `${s[0]}••••@••••`;
}

/**
 * Strips the contact fields a platform-introduced client's row must never
 * carry out of the API.
 *
 * Written as a whitelist-by-deletion over the row the query already produced,
 * rather than as a narrower SELECT in each of the four places that read
 * clients: a new column added to that table months from now is then a column
 * that has to be explicitly allowed through, not one that ships to every
 * operator because somebody forgot to update one query out of four.
 */
export function maskClientRow<T extends Record<string, unknown>>(
  row: T, acquired: string | null | undefined,
): T {
  if (acquired !== 'public') return row;
  const out: Record<string, unknown> = { ...row };
  if ('phone_e164' in out) out.phone_e164 = maskPhone(out.phone_e164 as string | null);
  if ('email' in out) out.email = maskEmail(out.email as string | null);
  // last_name is not withheld to be coy: a full name plus a street address is
  // enough to find somebody's landline, their electoral roll entry and their
  // employer, and the operator needs neither to do the job.
  if ('last_name' in out) out.last_name = null;
  return out as T;
}

/**
 * The doorstep, withdrawn again once the booking it was released for is gone.
 *
 * Migration 0022 released the street address to the operator at the moment a
 * booking exists and cleared `order_items.address_released_at` when it is
 * cancelled, saying in as many words that the column exists so that "can they
 * see it" is not re-derived from booking status in four different queries. It
 * then had no reader at all: cancelling a job cleared the column and the
 * schedule went on printing the address off the appointment row, so somebody
 * who booked and cancelled had handed a stranger their address permanently —
 * until the retention sweep caught up with it months later.
 *
 * Only rows that HAVE an order item are touched, and `released` is that item's
 * column. An appointment with no item is the operator's own booking, taken
 * from their own client list, and the release model has nothing to say about
 * an address they typed in themselves.
 */
export function maskWithdrawnAddress<T extends Record<string, unknown>>(
  row: T, orderItemId: string | null | undefined, released: number | null | undefined,
): T {
  if (!orderItemId || released != null) return row;
  const out: Record<string, unknown> = { ...row };
  // The coordinates go with the street line. A latitude and longitude to five
  // decimal places is the address, written differently.
  for (const k of ADDRESS_KEYS) if (k in out) out[k] = null;
  return out as T;
}

/** The three columns that are the doorstep, whatever table they arrive on. */
const ADDRESS_KEYS = ['address_line', 'lat', 'lng'] as const;

/**
 * The two derived columns `maskCustomerRow` needs, for a query that joins
 * clients by whatever alias it happens to use.
 *
 * `clientRef` is the client id expression in the caller's query — `a.client_id`
 * on the schedule, `c.id` on the client list, `l.client_id` on the leads list.
 * It is interpolated into SQL and must therefore be a literal written in this
 * repository, never anything that reached us over the wire; every call site
 * below passes a column name spelled out in the query beside it.
 *
 * A client may have several bookings, so the question is not "was this one
 * cancelled" but "is there still any live booking this address was released
 * for". MAX over the release timestamps answers exactly that: it is NULL when
 * every item has been cancelled and non-NULL while one survives. The id is
 * selected alongside it to tell "cancelled" apart from "no order item at all",
 * which is an operator's own booking and no business of the release model.
 */
export const addressReleaseColumns = (clientRef: string): string =>
  `(SELECT oi.id FROM order_items oi WHERE oi.client_id = ${clientRef} LIMIT 1)
     AS order_item_id,
   (SELECT MAX(oi.address_released_at) FROM order_items oi WHERE oi.client_id = ${clientRef})
     AS address_released_at`;

/**
 * Everything an operator-facing row of a customer's details has to go through,
 * in one call that cannot be half-made.
 *
 * The two masks above were correct and were applied in different places: the
 * schedule ran both, the client list and the leads list ran only the first, and
 * so a cancelled booking's street address and coordinates were withdrawn from
 * `/api/appointments` and served in full by `/api/clients` and `/api/leads`.
 * The comment on maskWithdrawnAddress said the problem was fixed. It was fixed
 * once, at one call site, which is the same failure maskClientRow was written
 * as a whitelist-by-deletion to avoid — and writing a second helper that also
 * has to be remembered would only move it.
 *
 * So this takes ONE argument. There is no argument order to get wrong, no
 * second call to leave out, and everything it needs it reads off the row.
 *
 * WHICH MAKES THE QUERY THE REMAINING WAY TO GET IT WRONG, and that is what
 * the last branch is for. A row that carries a doorstep but not the release
 * state is a query that forgot to ask whether the release still stands, and
 * the honest answer to a question nobody asked is no: the address is withheld.
 * Failing that way round turns a forgotten join into a visible blank on the
 * operator's screen rather than a stranger's address on it, and the fix — the
 * `addressReleaseColumns` fragment above — is named in this comment.
 */
export function maskCustomerRow<T extends Record<string, unknown>>(row: T): T {
  const out = maskClientRow({ ...row }, row.acquired as string | null | undefined);
  if (!ADDRESS_KEYS.some((k) => k in out && out[k] != null)) return out;

  if (!('order_item_id' in out) || !('address_released_at' in out)) {
    const blanked: Record<string, unknown> = { ...out };
    for (const k of ADDRESS_KEYS) if (k in blanked) blanked[k] = null;
    return blanked as T;
  }

  return maskWithdrawnAddress(
    out,
    out.order_item_id as string | null,
    out.address_released_at as number | null,
  );
}
