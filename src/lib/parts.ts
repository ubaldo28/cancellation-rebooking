import type { Env } from '../types';
import { threadByToken, threadForOperator } from './chat';
import { formatMoney, localeFor } from './countries';
import { notify } from './feed';
import { redactContact } from './redact';
import { badRequest, conflict, newId, notFound, now } from './util';

/**
 * Parts.
 *
 * The problem this solves, in one sentence: a mobile mechanic does not know
 * whether your car needs a $40 sensor or a $400 alternator until they are
 * under the hood, so asking them to name one price at checkout either prices
 * them out of the job or forces them to collect the difference in cash at the
 * door — off the platform, in exactly the conversation this product exists to
 * keep on the platform.
 *
 * Three policies, because there are only three honest shapes (see migration
 * 0020): 'none' (no parts, the price is the price), 'included' (parts are
 * already in the price, and we say so instead of leaving the customer to
 * guess), and 'quoted' (the part is not knowable in advance).
 *
 * For 'quoted', the flow is: the customer pays the labour in full at checkout,
 * the operator arrives and finds out what is needed, sends a quote into the
 * conversation that already exists for that booking, and the customer taps
 * approve or decline in the app. An approved quote is a second payment through
 * the site.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: nothing is ever charged that the
 * customer has not seen and approved. Not a rounding difference, not "it came
 * to a bit more", not cash at the door. Every function below is written to
 * make the unapproved charge impossible rather than merely discouraged.
 */

export const PARTS_POLICIES = ['none', 'included', 'quoted'] as const;
export type PartsPolicy = (typeof PARTS_POLICIES)[number];

export const isPartsPolicy = (v: unknown): v is PartsPolicy =>
  typeof v === 'string' && (PARTS_POLICIES as readonly string[]).includes(v);

/** A note longer than this is a contract, and it sits in a booking summary. */
const MAX_NOTE_CHARS = 300;
/** "Front pads and rotors, ceramic" is the job here. A parts list is not. */
const MAX_DESCRIPTION_CHARS = 300;

/**
 * How long a quote stays approvable: three days.
 *
 * Not open-ended, because a live quote is a standing authorisation to charge
 * somebody and part prices move. Not an hour either: the customer may be at
 * work while their car is being looked at, and a quote that dies before they
 * read it means the operator sits there resending it.
 */
const QUOTE_TTL_SECONDS = 3 * 24 * 60 * 60;

/** Nobody quotes a part costing more than this on a mobile job. It is a typo guard. */
const MAX_QUOTE_CENTS = 5_000_00;

export interface PartsFields {
  parts_policy: PartsPolicy;
  parts_note: string | null;
  parts_estimate_low_cents: number | null;
  parts_estimate_high_cents: number | null;
}

export interface PartsQuote {
  id: string;
  order_item_id: string;
  operator_id: string;
  thread_id: string | null;
  description: string;
  parts_cents: number;
  labor_cents: number;
  total_cents: number;
  currency: string;
  status: 'sent' | 'approved' | 'declined' | 'withdrawn' | 'expired';
  expires_at: number | null;
  decided_at: number | null;
  charged_at: number | null;
  created_at: number;
  updated_at: number;
}

const QUOTE_FIELDS =
  `id, order_item_id, operator_id, thread_id, description, parts_cents, labor_cents,
   currency, status, expires_at, decided_at, charged_at, created_at, updated_at`;

const withTotal = (r: Omit<PartsQuote, 'total_cents'>): PartsQuote =>
  ({ ...r, total_cents: r.parts_cents + r.labor_cents });

/**
 * Reads the parts half of a service form.
 *
 * One place, used by both the create and the update path, so an operator
 * cannot end up with a service whose policy was validated one way on Tuesday
 * and another way on Thursday.
 */
export function cleanPartsFields(b: Record<string, unknown>): PartsFields {
  const raw = b.parts_policy;
  // An unrecognised value falls back to 'none' rather than throwing. 'none' is
  // the policy that promises the customer the least, so a malformed request
  // can never accidentally attach "your bill may go up" to a car wash.
  const policy: PartsPolicy = isPartsPolicy(raw) ? raw : 'none';

  const note = typeof b.parts_note === 'string'
    ? b.parts_note.trim().slice(0, MAX_NOTE_CHARS) || null
    : null;

  const cents = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= MAX_QUOTE_CENTS ? n : null;
  };

  let low = cents(b.parts_estimate_low_cents);
  let high = cents(b.parts_estimate_high_cents);

  // A range is both numbers or neither. One alone renders as "$60–" and reads
  // as a broken page, which is worse than no estimate at all.
  if (low == null || high == null) { low = null; high = null; }
  // Swapped rather than rejected: somebody typing 400 then 40 meant a range,
  // and bouncing their form over field order helps nobody.
  if (low != null && high != null && low > high) { const t = low; low = high; high = t; }

  // An estimate only means anything when the part is the unknown. Carrying one
  // on a 'none' service would print a parts range under a car wash.
  if (policy !== 'quoted') { low = null; high = null; }

  return {
    parts_policy: policy,
    parts_note: note,
    parts_estimate_low_cents: low,
    parts_estimate_high_cents: high,
  };
}

/**
 * The single sentence a customer reads about parts, wherever they read it.
 *
 * Every surface — the slot page, the basket, the confirmation, the receipt —
 * calls this. Three different hand-written versions of "will my bill go up"
 * is three chances for one of them to be wrong, and the wrong one is the one
 * that gets screenshotted.
 */
export function partsLine(
  f: Pick<PartsFields, 'parts_policy' | 'parts_estimate_low_cents' | 'parts_estimate_high_cents'>,
  currency: string,
  locale = 'en-US',
): string | null {
  if (f.parts_policy === 'none') return null;
  if (f.parts_policy === 'included') return 'Parts are included in this price.';

  const range = f.parts_estimate_low_cents != null && f.parts_estimate_high_cents != null
    ? ` Most jobs land between ${formatMoney(f.parts_estimate_low_cents, currency, locale)}`
      + ` and ${formatMoney(f.parts_estimate_high_cents, currency, locale)} in parts.`
    : '';

  // Deliberately says what the money does, not just that parts exist. "Parts
  // extra" is what every shop sign says and it is why nobody trusts one.
  //
  // "Nothing is fitted until you approve it" is true today and will stay true.
  // The charging half is not: paying on the site is not built yet, and the
  // sentence used to imply that approving a quote takes money, which it does
  // not. Every other customer-facing surface was corrected to say so, and this
  // string reaches the customer in a message rather than on a page — a
  // confirmation that overstates what has happened to somebody's money is
  // worse than a web page that does.
  return 'This price covers the labour. If the job needs a part, they will send you '
    + 'the price here and nothing is fitted until you approve it. Nothing is '
    + 'paid on this site yet, so you settle the price with them directly.'
    + range;
}

// ---------------------------------------------------------------------------
// Who is allowed to touch a quote
// ---------------------------------------------------------------------------

interface ScopeItem {
  id: string;
  order_id: string;
  operator_id: string;
  appointment_id: string | null;
  starts_at: number;
  price_cents: number;
  parts_cents: number;
  cancelled_at: number | null;
  currency: string;
}

/**
 * Everything the holder of this guest link is allowed to see and answer.
 *
 * The customer has no account; the secret in their link is their identity, the
 * same as everywhere else here. That link points at a thread, the thread
 * points at one appointment, and that appointment is one item in an order —
 * so the scope is every item in THAT order belonging to THAT thread's
 * operator. Scoping to the single appointment instead would look right and
 * quietly break the real case: two slots at the same business in one basket
 * share one conversation, and a quote raised on the second one would be
 * unanswerable.
 */
async function guestScope(env: Env, rawToken: string) {
  const thread = await threadByToken(env, rawToken);
  if (!thread) return null;
  if (!thread.appointment_id) return { thread, items: [] as ScopeItem[] };

  const rows = await env.DB.prepare(
    `SELECT oi.id, oi.order_id, oi.operator_id, oi.appointment_id, oi.starts_at,
            oi.price_cents, oi.parts_cents, oi.cancelled_at, o.currency
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.order_id = (SELECT order_id FROM order_items WHERE appointment_id = ? LIMIT 1)
        AND oi.operator_id = ?`,
  ).bind(thread.appointment_id, thread.operator_id).all<ScopeItem>();

  return { thread, items: rows.results ?? [] };
}

// ---------------------------------------------------------------------------
// The operator sends one
// ---------------------------------------------------------------------------

export interface SendQuoteInput {
  order_item_id: string;
  description: string;
  parts_cents: number;
  labor_cents?: number;
}

/**
 * Send a parts quote to the customer.
 *
 * Any live quote on the same booking is withdrawn in the same batch, which is
 * the whole reason this is a batch. Migration 0020 puts a unique index over
 * live quotes so only one can exist, but an insert that fails on that index
 * leaves the operator staring at an error with a stale number still live on
 * the customer's phone. Replacing it is what they meant: the corrected quote
 * is the one that counts, and the customer can only ever approve the number
 * currently on their screen.
 */
export async function sendQuote(
  env: Env, operatorId: string, input: SendQuoteInput,
): Promise<PartsQuote> {
  // Filtered like a chat message, because that is what it is: free text the
  // operator writes and the customer reads on their phone. It had no filter at
  // all, which made it the operator's own way out of the conversation the rest
  // of this product works to keep on the platform -- "the alternator is $340,
  // call me on 818 555 0199 and I'll do it cash on Saturday" arrived intact.
  const description = redactContact(
    (input?.description ?? '').trim().slice(0, MAX_DESCRIPTION_CHARS),
  ).body.trim();
  if (!description) {
    throw badRequest('Say what the parts are. A price on its own is not something '
      + 'anyone can agree to.', 'no_description');
  }

  const money = (v: unknown, label: string): number => {
    const n = Math.round(Number(v ?? 0));
    if (!Number.isFinite(n) || n < 0) throw badRequest(`That ${label} is not a number.`, 'bad_amount');
    if (n > MAX_QUOTE_CENTS) throw badRequest(`That ${label} looks like a typo.`, 'bad_amount');
    return n;
  };
  const parts = money(input?.parts_cents, 'parts price');
  const labor = money(input?.labor_cents, 'extra labour');
  if (parts + labor <= 0) {
    throw badRequest('A quote needs an amount. If there is nothing extra to pay, '
      + 'just send them a message.', 'empty_quote');
  }

  const itemId = (input?.order_item_id ?? '').trim();
  const item = await env.DB.prepare(
    `SELECT oi.id, oi.order_id, oi.operator_id, oi.appointment_id, oi.starts_at,
            oi.price_cents, oi.parts_cents, oi.cancelled_at, o.currency, o.guest_name
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.id = ? AND oi.operator_id = ?`,
  ).bind(itemId, operatorId).first<ScopeItem & { guest_name: string | null }>();
  // Same answer for somebody else's booking as for one that does not exist.
  // Which order ids are real is not something an API should confirm.
  if (!item) throw notFound('That booking is not yours.');
  // quotableItems already excludes these, so the operator's own screen never
  // offers the button — but the screen is not the guard, and a quote raised
  // against a cancelled job is a live authorisation to charge somebody for
  // work nobody is going to do.
  if (item.cancelled_at) {
    throw conflict('That booking was cancelled, so there is nothing to quote for.',
      'was_cancelled');
  }

  const thread = await env.DB.prepare(
    `SELECT id FROM threads WHERE operator_id = ? AND appointment_id = ? LIMIT 1`,
  ).bind(operatorId, item.appointment_id).first<{ id: string }>();

  const op = await env.DB.prepare(
    `SELECT country, language, business_name FROM operators WHERE id = ?`,
  ).bind(operatorId).first<{ country: string; language: string; business_name: string }>();
  const locale = localeFor(op?.country ?? 'US', op?.language ?? 'en');

  const t = now();
  const quote: PartsQuote = {
    id: newId(),
    order_item_id: item.id,
    operator_id: operatorId,
    thread_id: thread?.id ?? null,
    description,
    parts_cents: parts,
    labor_cents: labor,
    total_cents: parts + labor,
    currency: item.currency,
    status: 'sent',
    expires_at: t + QUOTE_TTL_SECONDS,
    decided_at: null,
    charged_at: null,
    created_at: t,
    updated_at: t,
  };

  const total = formatMoney(quote.total_cents, quote.currency, locale);
  const body = labor > 0
    ? `${op?.business_name ?? 'The business'} sent a quote: ${description} — `
      + `${formatMoney(parts, quote.currency, locale)} parts and `
      + `${formatMoney(labor, quote.currency, locale)} extra labour, ${total} in total. `
      + 'Nothing is fitted or charged until you approve it.'
    : `${op?.business_name ?? 'The business'} sent a quote: ${description} — ${total}. `
      + 'Nothing is fitted or charged until you approve it.';

  const writes = [
    // Withdrawn, not deleted. The customer may already have seen the old
    // number and asked about it, and a row that vanished cannot answer that.
    env.DB.prepare(
      `UPDATE parts_quotes SET status='withdrawn', decided_at=?, updated_at=?
        WHERE order_item_id=? AND status='sent'`,
    ).bind(t, t, item.id),
    env.DB.prepare(
      `INSERT INTO parts_quotes (id, order_item_id, operator_id, thread_id, description,
         parts_cents, labor_cents, currency, status, expires_at, decided_at, charged_at,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,'sent',?,NULL,NULL,?,?)`,
    ).bind(quote.id, quote.order_item_id, quote.operator_id, quote.thread_id,
      quote.description, quote.parts_cents, quote.labor_cents, quote.currency,
      quote.expires_at, t, t),
  ];

  // The quote lands in the conversation as a message too, not only as a row.
  // The customer is not watching a bookings screen; they are looking at the
  // thread they have been using, and a quote that only exists in a panel they
  // have to go find is a quote nobody answers.
  if (quote.thread_id) {
    writes.push(env.DB.prepare(
      `INSERT INTO chat_messages (id, thread_id, sender, body, created_at)
       VALUES (?,?,'operator',?,?)`,
    ).bind(newId(), quote.thread_id, body, t));
    writes.push(env.DB.prepare(
      `UPDATE threads SET last_message_at=?, guest_unread = guest_unread + 1, updated_at=?
        WHERE id=? AND operator_id=?`,
    ).bind(t, t, quote.thread_id, operatorId));
  }

  await env.DB.batch(writes);
  return quote;
}

/** The operator takes a quote back before it is answered. */
export async function withdrawQuote(
  env: Env, operatorId: string, quoteId: string,
): Promise<void> {
  const t = now();
  const res = await env.DB.prepare(
    `UPDATE parts_quotes SET status='withdrawn', decided_at=?, updated_at=?
      WHERE id=? AND operator_id=? AND status='sent'`,
  ).bind(t, t, quoteId, operatorId).run();
  if ((res.meta.changes ?? 0) === 0) {
    throw conflict('That quote has already been answered.', 'quote_decided');
  }
}

// ---------------------------------------------------------------------------
// The customer answers it
// ---------------------------------------------------------------------------

/**
 * Approve or decline, authorised by nothing but the guest link.
 *
 * The status change is the money, and EVERY statement in the batch carries the
 * same `status='sent'` guard rather than only the one that flips it. That is
 * the whole correctness argument here and it used to be wrong: the flip was
 * first and guarded, the two `parts_cents = parts_cents + ?` statements
 * followed it unguarded, and a D1 batch is one transaction that commits
 * whatever its statements matched. So a customer double-tapping approve — on a
 * phone, on site, with one bar of signal — had the second tap add the parts a
 * second time and then be told the quote was already answered. That is the
 * difference between charging somebody $240 and charging them $480.
 *
 * The flip is therefore LAST. Every statement before it tests the row while it
 * still says 'sent'; the flip is what changes that, and its own change count
 * is what decides whether this call did anything at all.
 */
export async function decideQuote(
  env: Env, rawToken: string, quoteId: string, decision: 'approved' | 'declined',
): Promise<PartsQuote> {
  if (decision !== 'approved' && decision !== 'declined') {
    throw badRequest('Approve it or decline it.', 'bad_decision');
  }

  const scope = await guestScope(env, rawToken);
  if (!scope) throw notFound('That link is not valid any more.');

  const row = await env.DB.prepare(
    `SELECT ${QUOTE_FIELDS} FROM parts_quotes WHERE id = ?`,
  ).bind(quoteId).first<Omit<PartsQuote, 'total_cents'>>();
  if (!row || !scope.items.some((i) => i.id === row.order_item_id)) {
    throw notFound('That quote is not on your booking.');
  }

  const t = now();
  if (row.status !== 'sent') {
    throw conflict(
      row.status === 'withdrawn'
        ? 'The business took that quote back. They will send a new one.'
        : `That quote was already ${row.status}.`,
      'quote_decided',
    );
  }
  if (row.expires_at != null && row.expires_at <= t) {
    throw conflict('That quote has expired. Ask them to send a fresh one — '
      + 'part prices move.', 'quote_expired');
  }

  const item = scope.items.find((i) => i.id === row.order_item_id)!;
  // Approving parts for a job that was cancelled underneath the quote would
  // put money owed on a booking nobody is going to do. Declining is still
  // allowed: closing a stale quote is always safe.
  if (decision === 'approved' && item.cancelled_at) {
    throw conflict('That booking was cancelled, so there is nothing to approve.',
      'was_cancelled');
  }
  const amount = row.parts_cents + row.labor_cents;

  /** "…and only while that quote still says 'sent'." Appended to every write. */
  const stillSent = `EXISTS (SELECT 1 FROM parts_quotes q WHERE q.id = ? AND q.status = 'sent')`;

  const writes: D1PreparedStatement[] = [];

  if (decision === 'approved') {
    // -------------------------------------------------------------------
    // PAYMENT SEAM — the second charge.
    //
    // The first charge is at checkout, in placeOrder, for the labour the
    // customer agreed to then. THIS is the other one, and it is the only
    // other one: it may only ever be for exactly `amount`, the number on
    // the row the customer just approved. Not a recalculated figure, not
    // the operator's current price list, not a total. When the charge is
    // wired up it belongs on this line, before the batch, and it writes
    // charged_at on success — an approved quote with charged_at still NULL
    // is money owed, and that is the report the operator will ask for.
    //
    // Until then the totals below record what is owed and nothing moves.
    // -------------------------------------------------------------------
    writes.push(env.DB.prepare(
      `UPDATE order_items SET parts_cents = parts_cents + ?
        WHERE id = ? AND ${stillSent}`,
    ).bind(amount, item.id, quoteId));
    writes.push(env.DB.prepare(
      `UPDATE orders SET parts_cents = parts_cents + ?, updated_at = ?
        WHERE id = ? AND ${stillSent}`,
    ).bind(amount, t, item.order_id, quoteId));
  }

  const op = await env.DB.prepare(
    `SELECT country, language FROM operators WHERE id = ?`,
  ).bind(scope.thread.operator_id).first<{ country: string; language: string }>();
  const locale = localeFor(op?.country ?? 'US', op?.language ?? 'en');
  const money = formatMoney(amount, row.currency, locale);

  // Written into the transcript as the customer, because the customer is who
  // decided. An operator scrolling back is reading a conversation, and "you
  // said yes on the 3rd" has to be visible in it.
  if (row.thread_id) {
    writes.push(env.DB.prepare(
      `INSERT INTO chat_messages (id, thread_id, sender, body, created_at)
       SELECT ?,?,'guest',?,? WHERE ${stillSent}`,
    ).bind(newId(), row.thread_id,
      decision === 'approved'
        ? `Approved: ${row.description} — ${money}.`
        : `Declined: ${row.description} — ${money}.`,
      t, quoteId));
    writes.push(env.DB.prepare(
      `UPDATE threads SET last_message_at=?, operator_unread = operator_unread + 1,
         updated_at=? WHERE id=? AND ${stillSent}`,
    ).bind(t, t, row.thread_id, quoteId));
  }

  // Last, so everything above it saw the row as it was before the decision.
  writes.push(env.DB.prepare(
    `UPDATE parts_quotes SET status=?, decided_at=?, updated_at=?
      WHERE id=? AND status='sent'`,
  ).bind(decision, t, t, quoteId));

  const res = await env.DB.batch(writes);
  if ((res[writes.length - 1]?.meta.changes ?? 0) === 0) {
    throw conflict('That quote was already answered.', 'quote_decided');
  }

  // After the batch. A notification that will not insert must never undo a
  // decision the customer already made — same rule as everywhere else here.
  await notify(env, row.operator_id, {
    kind: 'parts_quote',
    title: decision === 'approved'
      ? `${scope.thread.guest_name} approved ${money} of parts`
      : `${scope.thread.guest_name} declined the ${money} quote`,
    body: row.description,
    appointment_id: item.appointment_id,
    thread_id: row.thread_id,
    starts_at: item.starts_at,
  });

  return withTotal({ ...row, status: decision, decided_at: t, updated_at: t });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every quote on this guest's booking, newest first, plus what is still answerable. */
export async function quotesForGuest(
  env: Env, rawToken: string,
): Promise<{ quotes: PartsQuote[]; parts_cents: number }> {
  const scope = await guestScope(env, rawToken);
  if (!scope || scope.items.length === 0) return { quotes: [], parts_cents: 0 };

  const ids = scope.items.map((i) => i.id);
  const rows = await env.DB.prepare(
    `SELECT ${QUOTE_FIELDS} FROM parts_quotes
      WHERE order_item_id IN (${ids.map(() => '?').join(',')})
      ORDER BY created_at DESC, rowid DESC`,
  ).bind(...ids).all<Omit<PartsQuote, 'total_cents'>>();

  return {
    quotes: (rows.results ?? []).map(withTotal),
    parts_cents: scope.items.reduce((a, i) => a + i.parts_cents, 0),
  };
}

/** The operator's quotes, newest first. Scoped by operator_id, always. */
export async function quotesForOperator(
  env: Env, operatorId: string, opts: { order_item_id?: string; limit?: number } = {},
): Promise<PartsQuote[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), 200);
  const rows = opts.order_item_id
    ? await env.DB.prepare(
        `SELECT ${QUOTE_FIELDS} FROM parts_quotes
          WHERE operator_id = ? AND order_item_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ).bind(operatorId, opts.order_item_id, limit).all<Omit<PartsQuote, 'total_cents'>>()
    : await env.DB.prepare(
        `SELECT ${QUOTE_FIELDS} FROM parts_quotes
          WHERE operator_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ).bind(operatorId, limit).all<Omit<PartsQuote, 'total_cents'>>();
  return (rows.results ?? []).map(withTotal);
}

/**
 * The bookings an operator can raise a quote against.
 *
 * Every booked item, not only the ones whose services were marked 'quoted'.
 * Restricting it would look tidier and break the real case: a pressure washer
 * quoted 'none' finds the spigot is cracked. The promise to the customer is
 * not "we will never ask for more" — it is that they see and approve anything
 * extra before it happens, and that holds whatever the service said.
 */
export async function quotableItems(env: Env, operatorId: string, limit = 50) {
  const rows = await env.DB.prepare(
    `SELECT oi.id, oi.appointment_id, oi.starts_at, oi.ends_at, oi.price_cents,
            oi.parts_cents, oi.arrived_at, oi.code_verified_at, oi.cancelled_at,
            o.currency, o.guest_name,
            (SELECT GROUP_CONCAT(s.name, ' + ') FROM order_item_services s
              WHERE s.order_item_id = oi.id) AS services,
            (SELECT COUNT(*) FROM parts_quotes q
              WHERE q.order_item_id = oi.id AND q.status = 'sent') AS live_quotes,
            (SELECT t.id FROM threads t
              WHERE t.operator_id = oi.operator_id
                AND t.appointment_id = oi.appointment_id LIMIT 1) AS thread_id
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.operator_id = ? AND o.status IN ('pending','confirmed')
        AND oi.cancelled_at IS NULL
      ORDER BY oi.starts_at DESC
      LIMIT ?`,
  ).bind(operatorId, Math.min(Math.max(1, Math.floor(limit)), 200)).all();
  return rows.results ?? [];
}

/**
 * Expires quotes nobody answered. Runs on the existing cron.
 *
 * A quote left 'sent' forever is a live authorisation to charge somebody for
 * parts priced weeks ago. Expiring it costs the operator one tap to resend and
 * removes a whole class of "I approved that ages ago, why is it different now".
 */
export async function expireQuotes(env: Env): Promise<number> {
  const t = now();
  const res = await env.DB.prepare(
    `UPDATE parts_quotes SET status='expired', updated_at=?
      WHERE status='sent' AND expires_at IS NOT NULL AND expires_at <= ?`,
  ).bind(t, t).run();
  return res.meta.changes ?? 0;
}

/** Re-exported so callers importing from here do not reach past this module. */
export { threadForOperator };
