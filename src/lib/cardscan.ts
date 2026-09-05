/**
 * Recognising card and bank details, and nothing else.
 *
 * Split out from ./payments so it can be used by util.ts — which json() lives
 * in, and which payments.ts imports — without the two files importing each
 * other. This half has no dependencies at all, on purpose: it is a pure
 * predicate over a value, and anything in the codebase may reach for it.
 *
 * See ./payments for what is done with a finding and where the checks are
 * mounted. The rule the two halves serve: a card number, a CVC, an expiry or a
 * full bank detail may never be accepted, stored, logged or returned by this
 * Worker. Only the processor's opaque reference.
 */

/**
 * Field names that may never carry a value, whatever that value looks like.
 *
 * A CVC is three digits and an expiry month is two: there is no pattern that
 * distinguishes either from any other small number, so the only way to catch
 * them is by the name of the field they arrive in. That makes this list
 * necessarily incomplete — a form posting `{ q1: '737' }` is invisible here —
 * but it catches every spelling a real payment form actually uses, which is
 * what a mis-wired integration will send.
 *
 * `expires_at` deliberately does NOT match: offers, quotes, requests and
 * sessions all carry one and none of them is a card.
 */
const SENSITIVE_KEY =
  /^(?:card(?:_?number|_?no|_?pan|_?cvc|_?cvv|_?exp(?:_?(?:month|year|date))?)?|number|pan|cc_?(?:num(?:ber)?|exp|cvc|cvv)|cvc|cvv2?|csc|cav2?|security_?code|exp(?:iry|iration)?(?:_?(?:month|year|date))?|iban|bban|swift|bic|routing_?number|account_?number|sort_?code|bank_?account)$/i;

/**
 * Field names whose value is a phone number and must not be read as a card.
 *
 * A 14- or 15-digit international number is rare but real, and one in ten of
 * them passes the Luhn check by chance. Without this a customer in the wrong
 * country would find the site refusing their booking with a message about card
 * numbers, which is both baffling and unfixable from their side.
 *
 * The E.164 exemption in looksLikePan() covers the stored form of a number;
 * this covers the typed form, before toE164 has normalised it.
 */
const PHONE_KEY =
  /(?:^|_)(?:phone|phone_e164|mobile|msisdn|tel|telephone|fax|whatsapp)(?:$|_)|^(?:to|from)_address$/i;

/**
 * A run of 13 to 19 digits, allowing the single spaces or hyphens a person
 * types between the groups on the front of a card.
 *
 * Thirteen at the bottom because that is the shortest card still in issue (an
 * old 13-digit Visa); nineteen at the top for UnionPay and long Maestro. The
 * bound is what keeps ordinary content out: prices are small, epoch seconds
 * are ten digits, and a UUID has letters in it.
 *
 * THE LOOKAROUND IS LOAD-BEARING AND WAS MISSING. Without it the run may sit
 * inside a longer alphanumeric token, and this codebase is full of one in
 * particular: a sha256 hex digest, which is what every session, offer link,
 * guest link and watch token is stored as. Sixty-four hex characters are about
 * five-eighths digits, so roughly one digest in four contains a run of
 * thirteen or more — and one in ten of those passes the Luhn check by chance.
 * That made this guard reject a random one per cent or so of every sign-in and
 * every guest link: an intermittent, unreproducible 400 on the most important
 * paths in the product, which is far worse than no guard at all.
 *
 * A real card number is written as its own token. Requiring it to be bounded
 * by something that is not a letter or a digit costs nothing on the values
 * this is meant to catch and removes the whole class of accident.
 */
const DIGIT_RUN = /(?<![A-Za-z0-9])\d(?:[ -]?\d){12,18}(?![A-Za-z0-9])/g;

/** A well-formed E.164 number, which is what a phone column holds. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * The Luhn check digit, which every card in the world satisfies and almost
 * nothing else does.
 *
 * This is what turns "a long number" into "a card number" with few enough
 * false positives to be worth failing a request over: it rejects nine out of
 * ten arbitrary digit strings before the prefix test has to say anything.
 */
export function luhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Is this string a card number?
 *
 * Three things have to hold, and each one keeps a different piece of ordinary
 * data out of the net:
 *
 *   1. thirteen to nineteen digits          — excludes money, timestamps, ids
 *   2. a major issuer prefix, 2 through 6   — excludes most long reference
 *                                             numbers, which start anywhere
 *   3. the Luhn check digit                 — excludes nine in ten of the rest
 *
 * A value that is already a well-formed E.164 phone number is exempt outright.
 * Nothing on a card carries a leading +, and a phone column is the one place a
 * long Luhn-valid digit string legitimately turns up.
 */
export function looksLikePan(value: string): boolean {
  const s = value.trim();
  if (E164.test(s)) return false;
  for (const m of s.match(DIGIT_RUN) ?? []) {
    const digits = m.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (!/^[2-6]/.test(digits)) continue;
    if (luhn(digits)) return true;
  }
  return false;
}

/**
 * An IBAN, checked properly rather than by shape.
 *
 * The mod-97 test is what makes this safe to act on: without it the pattern
 * "two letters, two digits, a run of alphanumerics" matches plenty of harmless
 * reference codes. With it, a false positive is roughly one in ninety-seven of
 * the strings that already have the shape.
 */
export function looksLikeIban(value: string): boolean {
  const s = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48;
    remainder = (remainder * (v > 9 ? 100 : 10) + v) % 97;
  }
  return remainder === 1;
}

export type CardFindingKind = 'pan' | 'iban' | 'named_field';

export interface CardFinding {
  kind: CardFindingKind;
  /** Where it was, so a developer can fix the caller. NEVER the value itself. */
  path: string;
}

/** Deep enough for any body this API accepts; a bound against a hostile input. */
const MAX_DEPTH = 8;

/**
 * Walks any value and reports the first thing that must not be there.
 *
 * Returns a description of WHERE, never WHAT. The value is the one thing that
 * must not be copied anywhere — not into an error message, not into a log line
 * and not into a response — because every one of those is another place it
 * would then have to be erased from.
 */
export function findCardData(value: unknown, path = ''): CardFinding | null {
  return walk(value, path, 0);
}

function walk(value: unknown, path: string, depth: number): CardFinding | null {
  if (value == null || depth > MAX_DEPTH) return null;

  if (typeof value === 'string') {
    if (looksLikePan(value)) return { kind: 'pan', path: path || '(root)' };
    if (looksLikeIban(value)) return { kind: 'iban', path: path || '(root)' };
    return null;
  }

  // A card number posted as a JSON number rather than a string is still a card
  // number, and sixteen digits fits inside a double exactly.
  if (typeof value === 'number') {
    return Number.isInteger(value) && looksLikePan(String(value))
      ? { kind: 'pan', path: path || '(root)' } : null;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = walk(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  if (typeof value === 'object') {
    // A File or Blob from a multipart form has no readable fields here, and
    // what it actually contains is checked by images.ts instead.
    if (typeof (value as Blob).arrayBuffer === 'function') return null;

    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const at = path ? `${path}.${k}` : k;

      // An empty string is a form field nobody filled in, not a card.
      if (v != null && String(v).trim() !== '' && SENSITIVE_KEY.test(k)) {
        return { kind: 'named_field', path: at };
      }

      if (typeof v === 'string' && PHONE_KEY.test(k)) continue;

      const hit = walk(v, at, depth + 1);
      if (hit) return hit;
    }
  }

  return null;
}

/**
 * A cheap pre-filter over already-serialised JSON.
 *
 * json() serialises the body anyway, so the response check runs over the
 * string it just produced rather than walking the object a second time. This
 * only says "there is a long digit run in here somewhere" — a hit is then
 * confirmed by findCardData against the original value, which knows about
 * field names and can tell a card from a phone number.
 */
export function mayContainPan(serialised: string): boolean {
  for (const m of serialised.match(DIGIT_RUN) ?? []) {
    const digits = m.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && /^[2-6]/.test(digits) && luhn(digits)) {
      return true;
    }
  }
  return false;
}
