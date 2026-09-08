import type { Env } from '../types';
import { threadByToken } from './chat';
import { claimPhoneHash } from './redact';
import { badRequest, newId, notFound, now, sha256 } from './util';

/**
 * Getting rid of things.
 *
 * Until this file there was no way to delete anything in this product. Not a
 * customer asking to be erased, not an operator closing their account, and not
 * the large amount of data that stops having a reason to exist about a week
 * after the job it belonged to. Everything that arrived, stayed — home
 * addresses, coordinates accurate to a doorstep, phone numbers, email
 * addresses, photographs of the inside of people's houses, and a running
 * record of where a self-employed person drove.
 *
 * Three separate jobs live here, and they are separate on purpose:
 *
 *   ERASURE      a customer asks for their personal data to be removed. Real
 *                deletion of the personal parts, immediately, on their say-so,
 *                proved either by the secret link in their confirmation or by
 *                the account that link's booking now belongs to. Both doors
 *                run the same code and remove the same rows.
 *   CLOSURE      an operator closes their account. The personal columns on
 *                their row are emptied and their customers' data goes with
 *                them; the settled financial records stay, describing a
 *                business that no longer exists rather than a person.
 *   SWEEPS       the cron, deleting what nobody asked about because it simply
 *                has no reason to still be here.
 *
 * WHAT IS KEPT, AND WHY. Money that has already moved is not erasable: an
 * invoice, a refund and a fee are records of a transaction between two
 * parties, and a marketplace that can be talked into deleting its own books is
 * a marketplace that cannot answer a chargeback or a tax question. So an
 * order, an order item and a lead fee survive both erasure and closure — with
 * every column that identifies a PERSON emptied. What remains is an amount, a
 * currency, a date and the business it was with.
 *
 * The other deliberate retention is a live safety record. A customer with an
 * active suspension or ban keeps their customer_standing row through an
 * erasure, because the alternative is that "delete my data" is also the button
 * that clears a ban, and the ladder in standing.ts stops meaning anything the
 * day somebody notices. It is the narrowest exception this file makes: the row
 * is deleted the moment the sanction lapses, and a customer with no sanction
 * has no row to keep.
 */

/**
 * How long each kind of thing lives when nobody asks.
 *
 * Every one of these is a judgement and they are gathered here so they can be
 * argued with in one place rather than found in six queries. The rule used to
 * pick them: how long after the job could this data still answer a question
 * somebody is entitled to ask? Past that it is not evidence, it is a liability
 * with a date on it.
 */
export const RETENTION = {
  /**
   * A conversation that never became a booking. Thirty days.
   *
   * Somebody asked a business a question and did not book. Neither side needs
   * that in April, and it carries a stranger's name and whatever they typed
   * about where they live.
   */
  THREAD_NO_BOOKING_DAYS: 30,

  /**
   * A conversation attached to a job that is over. A hundred and eighty days.
   *
   * This is the dispute window, and it is set by the longest thing that can
   * still arrive: a card chargeback, which most schemes allow for 120 days and
   * some for longer. Deleting the conversation before that leaves the operator
   * unable to show what was agreed at exactly the moment they need to.
   */
  THREAD_AFTER_JOB_DAYS: 180,

  /**
   * An instant request nobody accepted. Seven days.
   *
   * The row holds a name, a phone number, a street address and coordinates,
   * for a job that never happened, on a five-minute fuse. Its whole useful
   * life is those five minutes; a week is generous margin for the customer's
   * own page to still explain what happened.
   */
  INSTANT_REQUEST_DEAD_DAYS: 7,
  /** One that became a booking: the order holds it now, so this copy goes. */
  INSTANT_REQUEST_ACCEPTED_DAYS: 30,

  /** A watch the customer switched off. Ninety days, then the postcode goes. */
  WATCH_INACTIVE_DAYS: 90,
  /** A watch that has never matched anything in a year is a stale postcode. */
  WATCH_UNUSED_DAYS: 365,

  /**
   * Photographs of a job. Ninety days after it ended.
   *
   * These are the inside of somebody's home and they exist for one purpose:
   * to settle a dispute about whether the work happened. Ninety days is past
   * every window in this codebase for raising one. A photo the customer chose
   * to publish on their own review is not swept — that one they made public on
   * purpose, and it is theirs to unpublish.
   */
  JOB_PHOTO_DAYS: 90,

  /**
   * The exact address and coordinates of a finished job. Ninety days.
   *
   * The sharpest data in the product. A latitude and longitude to five decimal
   * places is a doorstep, and after the van has been and gone there is no
   * question it answers. The postcode is kept — it is the coarse geography the
   * business needs to know where it works — and the street line and the
   * coordinates are removed.
   */
  JOB_LOCATION_DAYS: 90,

  /** Feed rows, which carry FEED_EXCERPT_CHARS of a chat message. */
  NOTIFICATION_DAYS: 90,

  /** The SMS/device log, whose to_address column is a phone number. */
  MESSAGE_LOG_DAYS: 180,

  /** A lapsed customer standing record. Two years, then the number goes. */
  STANDING_DAYS: 730,
} as const;

const DAY = 86400;

/** How many photo objects one cron tick will delete from R2. */
const PHOTO_SWEEP_BATCH = 200;

/** Peppered so a hash in the erasure receipt is useless in a stolen dump. */
const subjectHash = (env: Env, value: string) => sha256(`${value}:${env.SESSION_PEPPER}`);

export interface SweepResult {
  /** Rows removed or scrubbed, by the sweep that did it. */
  [pass: string]: number;
}

const changes = (r: { meta?: { changes?: number } } | undefined): number =>
  r?.meta?.changes ?? 0;

// ---------------------------------------------------------------------------
// The sweeps
// ---------------------------------------------------------------------------

/**
 * Conversations with nothing left to say.
 *
 * chat_messages cascades off threads, so deleting the thread takes the
 * transcript with it — which is the point: the transcript is where a gate
 * code, a "the spare key is under the pot" and a description of somebody's
 * house actually live.
 *
 * Two passes because there are two different clocks. A thread that never
 * became a booking is measured from the last thing anybody said; a thread
 * attached to a job is measured from the end of the job, because a
 * conversation that went quiet in January about work done in June is not
 * stale.
 */
export async function sweepThreads(env: Env): Promise<number> {
  const t = now();

  const orphaned = await env.DB.prepare(
    `DELETE FROM threads
      WHERE last_message_at < ?
        AND (appointment_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id = threads.appointment_id))`,
  ).bind(t - RETENTION.THREAD_NO_BOOKING_DAYS * DAY).run();

  const finished = await env.DB.prepare(
    `DELETE FROM threads
      WHERE appointment_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM appointments a
                     WHERE a.id = threads.appointment_id
                       AND a.status IN ('completed','cancelled','no_show')
                       AND a.ends_at < ?)`,
  ).bind(t - RETENTION.THREAD_AFTER_JOB_DAYS * DAY).run();

  return changes(orphaned) + changes(finished);
}

/**
 * Instant requests that went nowhere, and ones that became bookings.
 *
 * Pending rows are never touched however old they look: expiry is decided on
 * read in online.ts, and a sweep that deleted one out from under a customer
 * polling their own page would turn "nobody answered" into "that request does
 * not exist", which reads as the site losing their booking.
 */
export async function sweepInstantRequests(env: Env): Promise<number> {
  const t = now();
  const dead = await env.DB.prepare(
    `DELETE FROM instant_requests
      WHERE status IN ('expired','declined','cancelled') AND created_at < ?`,
  ).bind(t - RETENTION.INSTANT_REQUEST_DEAD_DAYS * DAY).run();

  const accepted = await env.DB.prepare(
    `DELETE FROM instant_requests WHERE status = 'accepted' AND created_at < ?`,
  ).bind(t - RETENTION.INSTANT_REQUEST_ACCEPTED_DAYS * DAY).run();

  return changes(dead) + changes(accepted);
}

/**
 * Standing alerts nobody is using.
 *
 * A watch is a home postcode with coordinates next to a browser push endpoint.
 * Migration 0013 keeps a switched-off watch rather than deleting it, so an
 * accidental unsubscribe is one tap to undo — that reasoning holds for a
 * fortnight and stops holding after three months, at which point it is a
 * stranger's home location kept against a decision they already made.
 *
 * push_subscriptions and watch_hits both cascade off the watch.
 */
export async function sweepWatches(env: Env): Promise<number> {
  const t = now();
  const res = await env.DB.prepare(
    `DELETE FROM watches
      WHERE (active = 0 AND updated_at < ?)
         OR (active = 1 AND last_notified_at IS NULL AND created_at < ?)`,
  ).bind(t - RETENTION.WATCH_INACTIVE_DAYS * DAY,
    t - RETENTION.WATCH_UNUSED_DAYS * DAY).run();
  return changes(res);
}

/**
 * Photographs past the window in which anybody could still be arguing.
 *
 * The R2 object goes before the row, in that order, because the row is what
 * proves the object should exist: a failure part-way through leaves an object
 * with no row, which the next tick cannot find but which costs storage, and
 * that is strictly better than a row pointing at nothing, which shows a
 * customer a broken photo in a dispute.
 *
 * Released review photos are excluded. The customer published that one
 * deliberately, on their own review, and taking it down on a timer would
 * silently edit their review three months later.
 */
export async function sweepJobPhotos(env: Env): Promise<number> {
  const t = now();
  const cutoff = t - RETENTION.JOB_PHOTO_DAYS * DAY;

  const rows = await env.DB.prepare(
    `SELECT p.id, p.r2_key FROM job_photos p
      WHERE p.public_on_review = 0
        AND p.created_at < ?
        AND EXISTS (SELECT 1 FROM order_items oi
                     WHERE oi.id = p.order_item_id AND oi.ends_at < ?)
      LIMIT ?`,
  ).bind(cutoff, cutoff, PHOTO_SWEEP_BATCH).all<{ id: string; r2_key: string }>();

  const found = rows.results ?? [];
  if (found.length === 0) return 0;

  for (const p of found) {
    if (env.PHOTOS) await env.PHOTOS.delete(p.r2_key).catch(() => {});
  }

  const holes = found.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `DELETE FROM job_photos WHERE id IN (${holes})`,
  ).bind(...found.map((p) => p.id)).run();

  return changes(res);
}

/**
 * The doorstep, removed from jobs that are over.
 *
 * Four tables hold the same address because each of them needed it at a
 * different moment: the appointment for routing, the order for the receipt,
 * the claim for the race, the client for next time. That is defensible while
 * the work is live and indefensible three months later, so all four are
 * scrubbed together — street line and coordinates gone, postcode kept.
 *
 * Only clients the PLATFORM introduced are touched. An operator's own imported
 * list is their business record: they typed those addresses in themselves and
 * nothing here has any business editing them.
 */
export async function sweepJobLocations(env: Env): Promise<number> {
  const t = now();
  const cutoff = t - RETENTION.JOB_LOCATION_DAYS * DAY;
  let n = 0;

  n += changes(await env.DB.prepare(
    `UPDATE appointments SET address_line = NULL, lat = NULL, lng = NULL, updated_at = ?
      WHERE status IN ('completed','cancelled','no_show') AND ends_at < ?
        AND (address_line IS NOT NULL OR lat IS NOT NULL)`,
  ).bind(t, cutoff).run());

  n += changes(await env.DB.prepare(
    `UPDATE orders SET address_line = NULL, lat = NULL, lng = NULL, updated_at = ?
      WHERE (address_line IS NOT NULL OR lat IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM order_items oi
                         WHERE oi.order_id = orders.id AND oi.ends_at >= ?)
        AND created_at < ?`,
  ).bind(t, cutoff, cutoff).run());

  n += changes(await env.DB.prepare(
    `UPDATE public_claims SET address_line = NULL, lat = NULL, lng = NULL, updated_at = ?
      WHERE (address_line IS NOT NULL OR lat IS NOT NULL) AND created_at < ?`,
  ).bind(t, cutoff).run());

  n += changes(await env.DB.prepare(
    `UPDATE clients SET address_line = NULL, lat = NULL, lng = NULL,
            geocode_status = 'pending', geocoded_at = NULL, updated_at = ?
      WHERE acquired = 'public'
        AND (address_line IS NOT NULL OR lat IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM appointments a
                         WHERE a.client_id = clients.id AND a.ends_at >= ?)
        AND created_at < ?`,
  ).bind(t, cutoff, cutoff).run());

  return n;
}

/** Feed rows carry the first FEED_EXCERPT_CHARS of somebody's message. */
export async function sweepNotifications(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    `DELETE FROM notifications WHERE created_at < ?`,
  ).bind(now() - RETENTION.NOTIFICATION_DAYS * DAY).run();
  return changes(res);
}

/** The outbound SMS log, whose to_address column is a phone number. */
export async function sweepMessageLog(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    `DELETE FROM messages WHERE created_at < ?`,
  ).bind(now() - RETENTION.MESSAGE_LOG_DAYS * DAY).run();
  return changes(res);
}

/**
 * Customer standing rows whose sanction has lapsed.
 *
 * This is what gives the safety record an end. A ban is kept — it has no end
 * date by design, see migration 0023 — and everything else stops being a
 * phone number on our servers two years after it last mattered.
 */
export async function sweepStanding(env: Env): Promise<number> {
  const t = now();
  const res = await env.DB.prepare(
    `DELETE FROM customer_standing
      WHERE banned_at IS NULL
        AND (suspended_until IS NULL OR suspended_until < ?)
        AND updated_at < ?`,
  ).bind(t, t - RETENTION.STANDING_DAYS * DAY).run();
  return changes(res);
}

/**
 * Every sweep, in one call, for the cron.
 *
 * Each pass is caught separately: one failing query must not stop the other
 * seven, because the failure mode of a retention sweep that silently stops
 * running is a database that quietly goes back to keeping everything forever.
 */
export async function sweepRetention(env: Env): Promise<SweepResult> {
  const passes: Array<[string, () => Promise<number>]> = [
    ['threads', () => sweepThreads(env)],
    ['instant_requests', () => sweepInstantRequests(env)],
    ['watches', () => sweepWatches(env)],
    ['job_photos', () => sweepJobPhotos(env)],
    ['job_locations', () => sweepJobLocations(env)],
    ['notifications', () => sweepNotifications(env)],
    ['message_log', () => sweepMessageLog(env)],
    ['standing', () => sweepStanding(env)],
  ];

  const out: SweepResult = {};
  for (const [name, run] of passes) {
    try {
      out[name] = await run();
    } catch (e) {
      out[name] = -1;
      console.error(`retention sweep ${name} failed`, e);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A customer asking to be erased
// ---------------------------------------------------------------------------

export interface ErasureResult {
  /** What went, by table, so the customer can be told something concrete. */
  removed: Record<string, number>;
  /** True when a live suspension or ban meant one row had to stay. */
  standing_retained: boolean;
}

/**
 * Whether this number is under a sanction that has to outlive an erasure.
 *
 * The one exception in this file, and it is deliberately narrow: without it,
 * "erase my data" is also the button that clears a ban, and every suspended
 * customer finds that out within a week of the first one doing it.
 */
async function sanctioned(env: Env, phone: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT banned_at, suspended_until FROM customer_standing WHERE phone_e164 = ?`,
  ).bind(phone).first<{ banned_at: number | null; suspended_until: number | null }>();
  if (!row) return false;
  return !!row.banned_at || (!!row.suspended_until && row.suspended_until > now());
}

/**
 * Erases a customer, proved by the secret link in their confirmation.
 *
 * THIS PATH KEEPS WORKING EXACTLY AS IT DID, and migration 0037 adding
 * accounts is not allowed to change that. Somebody reading their booking on a
 * phone that has never been signed in must be able to ask to be forgotten from
 * the page they are already on; making them verify a mobile number first would
 * be asking somebody to create an account in order to delete one. The link IS
 * the authority here: it already reads the whole booking, the conversation and
 * the photographs, so somebody holding it can already see everything this
 * removes.
 *
 * A customer who does have an account reaches the same erasure through
 * DELETE /api/customer/data, which is behind their session and runs the same
 * function — see eraseCustomerByPhone below.
 *
 * SCOPE. The thread names one booking; the booking names a phone number; the
 * phone number is what ties this person's rows together across every business
 * they have used here. So erasure follows the number, not the thread — a
 * customer who asks to be forgotten and finds that only one of their three
 * bookings went has not been forgotten.
 *
 * A conversation that never became a booking has no number attached, and there
 * the erasure is exactly what there is: the thread and its messages.
 */
export async function eraseCustomerByToken(
  env: Env, rawToken: string,
): Promise<ErasureResult> {
  const thread = await threadByToken(env, rawToken ?? '');
  if (!thread) throw notFound('That link is not valid any more.');

  // The number on the order this link belongs to, if there is an order yet.
  const order = thread.appointment_id
    ? await env.DB.prepare(
        `SELECT o.id, o.phone_e164, o.email FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
          WHERE oi.appointment_id = ? LIMIT 1`,
      ).bind(thread.appointment_id).first<{
        id: string; phone_e164: string | null; email: string | null;
      }>()
    : null;

  const phone = order?.phone_e164 ?? null;

  if (!phone) {
    // Nothing but a conversation. Deleting the thread takes the messages with
    // it, and that is the whole of this person's footprint — except for the
    // feed rows below, which are the copy of it kept somewhere else.
    const removed: Record<string, number> = {};
    const add = (k: string, n: number) => { removed[k] = (removed[k] ?? 0) + n; };
    add('notifications', changes(await env.DB.prepare(
      `DELETE FROM notifications WHERE thread_id = ?`,
    ).bind(thread.id).run()));
    const res = await env.DB.prepare(`DELETE FROM threads WHERE id = ?`)
      .bind(thread.id).run();
    add('threads', changes(res));
    await recordErasure(env, 'customer', thread.id, sum(removed));
    return { removed, standing_retained: false };
  }

  // The thread this link named is passed through because it may not be one of
  // the ones reachable from an appointment: an enquiry that later became a
  // booking keeps its original thread, and dropping it here would leave the
  // conversation standing after everything it was about had gone.
  return eraseCustomerByPhone(env, phone, { extraThreadIds: [thread.id] });
}

/**
 * The same erasure, reached from a signed-in account instead of from a link.
 *
 * ONE IMPLEMENTATION, TWO DOORS, and it is one implementation deliberately.
 * The link path and the account path have to remove exactly the same rows --
 * a customer who is erased through their account and finds that the version
 * of erasure reachable from a link went further has not been erased -- and two
 * copies of a fourteen-step deletion drift the first time one of them gains a
 * table. So the link path resolves its token to a number and calls this, and
 * this is the only place that knows what erasing somebody means.
 *
 * The scope is the NUMBER, not the account and not the booking. That is what
 * makes "forget me" reach the March booking made before there was an account,
 * the June one made after it, and the conversations attached to both.
 */
export async function eraseCustomerByPhone(
  env: Env, phone: string, opts: { extraThreadIds?: string[] } = {},
): Promise<ErasureResult> {
  const removed: Record<string, number> = {};
  const add = (k: string, n: number) => { removed[k] = (removed[k] ?? 0) + n; };

  const retainStanding = await sanctioned(env, phone);

  // Everything this person has, found once through the number.
  const orders = await env.DB.prepare(
    `SELECT id FROM orders WHERE phone_e164 = ?`,
  ).bind(phone).all<{ id: string }>();
  const orderIds = (orders.results ?? []).map((r) => r.id);

  const items = orderIds.length
    ? await env.DB.prepare(
        `SELECT id, appointment_id, client_id FROM order_items
          WHERE order_id IN (${orderIds.map(() => '?').join(',')})`,
      ).bind(...orderIds).all<{
        id: string; appointment_id: string | null; client_id: string | null;
      }>()
    : { results: [] as Array<{ id: string; appointment_id: string | null; client_id: string | null }> };

  const itemIds = (items.results ?? []).map((r) => r.id);
  const appointmentIds = (items.results ?? [])
    .map((r) => r.appointment_id).filter((v): v is string => !!v);

  // Every mailbox this person has given us, read HERE and used at step 9.
  //
  // Read before anything is emptied, which is the whole reason it is up here
  // rather than beside the delete it feeds: step 4 clears both the email and
  // the phone number off the order rows, so the same query run in its natural
  // place would return nothing at all and the standing alerts would survive
  // the erasure — the most visible possible way to fail at one, since they
  // keep arriving by email afterwards. The account is asked as well as the
  // orders, because somebody may have set an address on the account and never
  // typed one into a checkout.
  const mailboxes = new Set<string>();
  for (const r of ((await env.DB.prepare(
    `SELECT DISTINCT email FROM orders WHERE phone_e164 = ? AND email IS NOT NULL`,
  ).bind(phone).all<{ email: string }>()).results ?? [])) mailboxes.add(r.email);
  for (const r of ((await env.DB.prepare(
    `SELECT DISTINCT email FROM customer_accounts
      WHERE phone_e164 = ? AND email IS NOT NULL`,
  ).bind(phone).all<{ email: string }>()).results ?? [])) mailboxes.add(r.email);

  // 1. Photographs. The objects first, then the rows — including any the
  //    customer had published on a review, because "erase me" covers the
  //    picture of their hallway they once chose to show.
  if (itemIds.length) {
    const holes = itemIds.map(() => '?').join(',');
    const photos = await env.DB.prepare(
      `SELECT id, r2_key FROM job_photos WHERE order_item_id IN (${holes})`,
    ).bind(...itemIds).all<{ id: string; r2_key: string }>();
    for (const p of photos.results ?? []) {
      if (env.PHOTOS) await env.PHOTOS.delete(p.r2_key).catch(() => {});
    }
    add('job_photos', changes(await env.DB.prepare(
      `DELETE FROM job_photos WHERE order_item_id IN (${holes})`,
    ).bind(...itemIds).run()));
  }

  // 2. Feed rows, before the conversations they point at.
  //
  //    THE ONE COPY OF THIS PERSON THAT NOTHING HERE USED TO REACH. Every step
  //    in this function either deletes a row or empties the columns that name
  //    somebody, because those are all read out of tables. A notification is
  //    not: it is a sentence written at the moment something happened, holding
  //    the customer's first name and an excerpt of what they wrote, and it
  //    survived erasure entirely — an operator who was told "that person asked
  //    to be forgotten" could still scroll their Bookings tab and read them.
  //    The retention sweep got there in the end, which is not what somebody
  //    asking to be erased is asking for.
  //
  //    Deleted rather than emptied, unlike the appointment and the claim: a
  //    notification is a nudge about something that has already been dealt
  //    with, so there is no business record inside it to keep. Found by both
  //    of the keys a feed row can carry, because a chat notification names the
  //    thread and a booking notification names the appointment.
  const threadIds = [...(opts.extraThreadIds ?? []), ...(appointmentIds.length
    ? ((await env.DB.prepare(
        `SELECT id FROM threads WHERE appointment_id IN (${appointmentIds.map(() => '?').join(',')})`,
      ).bind(...appointmentIds).all<{ id: string }>()).results ?? []).map((r) => r.id)
    : [])];

  const feedKeys: Array<[string, string[]]> = [
    ['appointment_id', appointmentIds],
    ['thread_id', threadIds],
  ];
  for (const [column, ids] of feedKeys) {
    if (!ids.length) continue;
    add('notifications', changes(await env.DB.prepare(
      `DELETE FROM notifications WHERE ${column} IN (${ids.map(() => '?').join(',')})`,
    ).bind(...ids).run()));
  }

  // 3. Conversations, which cascade to every message in them.
  if (appointmentIds.length) {
    const holes = appointmentIds.map(() => '?').join(',');
    add('threads', changes(await env.DB.prepare(
      `DELETE FROM threads WHERE appointment_id IN (${holes})`,
    ).bind(...appointmentIds).run()));
  }
  if (threadIds.length) {
    add('threads', changes(await env.DB.prepare(
      `DELETE FROM threads WHERE id IN (${threadIds.map(() => '?').join(',')})`,
    ).bind(...threadIds).run()));
  }

  // 4. The order rows. Real deletion of every personal column; the money, the
  //    currency and the dates stay, because a settled transaction is not the
  //    customer's to erase and is no longer about a person once these are out.
  if (orderIds.length) {
    const holes = orderIds.map(() => '?').join(',');
    add('orders', changes(await env.DB.prepare(
      `UPDATE orders SET guest_name = 'Removed', phone_e164 = NULL, email = NULL,
              address_line = NULL, postcode = NULL, lat = NULL, lng = NULL,
              thread_token_hash = NULL, updated_at = ?
        WHERE id IN (${holes})`,
    ).bind(now(), ...orderIds).run()));
  }

  // 5. The appointment: kept as a business record of work done, emptied of
  //    where it happened and of anything anybody wrote about the household.
  if (appointmentIds.length) {
    const holes = appointmentIds.map(() => '?').join(',');
    add('appointments', changes(await env.DB.prepare(
      `UPDATE appointments SET address_line = NULL, postcode = NULL, lat = NULL,
              lng = NULL, notes = NULL, updated_at = ?
        WHERE id IN (${holes})`,
    ).bind(now(), ...appointmentIds).run()));
  }

  // 6. The claim row, which holds the doorstep for the booking race.
  //
  // Emptied rather than deleted: the unique index on gap_id is what stops two
  // people confirming the same opening, and removing the row would take that
  // guard away from a slot that may still be in the future.
  //
  // Found by the peppered digest of the number rather than by the number,
  // because migration 0035 took the number itself off this table -- it sat
  // beside an operator_id, was read by nothing, and was one `SELECT *` away
  // from being the whole promise. The reach is the same as it was: every claim
  // this person ever made, at every business, not merely the one whose link
  // they happened to open.
  //
  // The second arm is for claims written before that migration, which have no
  // digest and could not be given one. Those are reachable through the
  // appointment the order names, and this is the only way back to them.
  const claimHoles = appointmentIds.length
    ? ` OR appointment_id IN (${appointmentIds.map(() => '?').join(',')})` : '';
  add('public_claims', changes(await env.DB.prepare(
    `UPDATE public_claims SET phone_hash = NULL,
            address_line = NULL, postcode = NULL, lat = NULL, lng = NULL, updated_at = ?
      WHERE phone_hash = ?${claimHoles}`,
  ).bind(now(), await claimPhoneHash(env, phone), ...appointmentIds).run()));

  // 7. Client rows the PLATFORM created for this person. Deleted outright:
  //    appointments hold client_id ON DELETE SET NULL, so the work survives.
  //    An operator's own imported client with the same number is untouched —
  //    they typed that in themselves and it is their record, not ours.
  add('clients', changes(await env.DB.prepare(
    `DELETE FROM clients WHERE phone_e164 = ? AND acquired = 'public'`,
  ).bind(phone).run()));

  // 8. Reviews. The rating and the words stay — they are the business's
  //    record and other customers rely on them — and the name attached to
  //    them goes, which is the part that identifies anybody.
  if (itemIds.length) {
    const holes = itemIds.map(() => '?').join(',');
    add('reviews', changes(await env.DB.prepare(
      `UPDATE reviews SET author_name = 'A customer', updated_at = ?
        WHERE order_item_id IN (${holes}) AND author_name <> 'A customer'`,
    ).bind(now(), ...itemIds).run()));
  }

  // 9. Requests that never became anything, and the alert watches on this
  //    person's mailbox.
  add('instant_requests', changes(await env.DB.prepare(
    `DELETE FROM instant_requests WHERE phone_e164 = ?`,
  ).bind(phone).run()));

  // The mailboxes gathered at the top of this function, before step 4 emptied
  // the rows they were read from.
  for (const email of mailboxes) {
    add('watches', changes(await env.DB.prepare(
      `DELETE FROM watches WHERE email = ?`,
    ).bind(email).run()));
  }

  add('messages', changes(await env.DB.prepare(
    `DELETE FROM messages WHERE to_address = ?`,
  ).bind(phone).run()));

  // 10. The dispute record. An open report, or one behind a live sanction,
  //    keeps the number it needs to find the standing row. Everything settled
  //    loses both the number and whatever prose was written about the person.
  add('no_show_reports', changes(await env.DB.prepare(
    `UPDATE no_show_reports SET phone_e164 = NULL, note = NULL, updated_at = ?
      WHERE phone_e164 = ? AND status <> 'open' AND ? = 0`,
  ).bind(now(), phone, retainStanding ? 1 : 0).run()));

  // 11. The account itself, if this number ever made one.
  //
  //     Emptied and closed rather than deleted, and the number set to NULL,
  //     which is what releases it: the unique index treats NULLs as distinct,
  //     so the row can sit here forever without stopping the same person
  //     signing up again one day. Every session on it dies in the same breath,
  //     because a cookie in a browser must not outlive the row it names — and
  //     currentCustomer refuses on closed_at anyway, which is the second of
  //     the two reasons that is true.
  //
  //     The row is kept rather than deleted for the same reason the order is:
  //     order_items and reviews point at work that really happened, and a
  //     dangling id is worse evidence than an emptied one. Nothing
  //     identifying a person is left on it.
  add('customer_sessions', changes(await env.DB.prepare(
    `UPDATE customer_sessions SET revoked_at = ?
      WHERE revoked_at IS NULL AND account_id IN (
        SELECT id FROM customer_accounts WHERE phone_e164 = ?)`,
  ).bind(now(), phone).run()));
  add('customer_login_codes', changes(await env.DB.prepare(
    `DELETE FROM customer_login_codes WHERE phone_e164 = ?`,
  ).bind(phone).run()));
  add('customer_accounts', changes(await env.DB.prepare(
    `UPDATE customer_accounts
        SET phone_e164 = NULL, first_name = NULL, email = NULL,
            payment_ref = NULL, payment_brand = NULL, payment_last4 = NULL,
            payment_added_at = NULL, password_hash = NULL,
            closed_at = COALESCE(closed_at, ?), updated_at = ?
      WHERE phone_e164 = ?`,
  ).bind(now(), now(), phone).run()));

  // 12. Standing, and the suspensions that produced it.
  if (!retainStanding) {
    add('customer_standing', changes(await env.DB.prepare(
      `DELETE FROM customer_standing WHERE phone_e164 = ?`,
    ).bind(phone).run()));
    add('suspensions', changes(await env.DB.prepare(
      `DELETE FROM suspensions WHERE subject_kind = 'customer' AND subject_id = ?`,
    ).bind(phone).run()));
  }

  await recordErasure(env, 'customer', phone, sum(removed));
  return { removed, standing_retained: retainStanding };
}

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

/**
 * The van's last fix and its trail, erased.
 *
 * THE ONE PIECE OF PERSONAL DATA IN THIS PRODUCT THAT IS NOT IN D1. Position
 * pings stopped being rows in migration 0015 and became state on a Durable
 * Object -- see src/do/van.ts -- and every deletion path in this file was
 * written against the database, so not one of them ever reached it.
 * VanTracker.clear() has existed since the day that object was written and
 * nothing outside the tests had ever called it. The result was that an
 * operator's last known position and up to twenty sampled points of where they
 * drove stayed in Durable Object storage indefinitely: after they switched
 * location sharing off, and after they closed the account this file is
 * otherwise so careful to empty. Both of those are a person saying "stop
 * holding where I am", and neither of them did anything about it.
 *
 * Failures are swallowed on purpose. The object may never have been created,
 * the binding is optional in every environment that has not run the tracking
 * migration, and a tracking-storage hiccup must not be what makes an account
 * closure or a privacy toggle fail -- the caller has already done, or is about
 * to do, the part that is recorded.
 */
interface VanClearStub { clear(): Promise<void> }
interface VanClearNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): VanClearStub;
}

export async function forgetVan(env: Env, operatorId: string): Promise<void> {
  const id = (operatorId ?? '').trim();
  if (!id) return;
  const ns = (env as unknown as { VAN?: VanClearNamespace }).VAN;
  if (!ns) return;
  try { await ns.get(ns.idFromName(id)).clear(); }
  catch (e) { console.error('van clear failed', id, e); }
}

/** The receipt. A peppered hash of the subject, never the subject. */
async function recordErasure(
  env: Env, kind: 'customer' | 'operator', subject: string, rows: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO erasures (id, subject_kind, subject_hash, rows_removed, created_at)
     VALUES (?,?,?,?,?)`,
  ).bind(newId(), kind, await subjectHash(env, subject), rows, now()).run();
}

// ---------------------------------------------------------------------------
// An operator closing their account
// ---------------------------------------------------------------------------

/**
 * Closes an operator's account.
 *
 * NOT A FLAG ON A ROW THAT STILL HOLDS EVERYTHING. The personal columns are
 * really emptied: the email they sign in with, their phone number, their home
 * address and its coordinates, their licence number, their insurance policy
 * number, the name a background check was run against, their vehicle's
 * registration plate, their social handles, their avatar. What is left is a
 * business name of "Closed business", a country, a currency and a timezone —
 * which is what the financial rows pointing at this id need in order to still
 * make sense, and which identifies nobody.
 *
 * It also takes their customers' data with it. An operator's client list,
 * their conversations and the instant requests strangers sent them are all
 * personal data about OTHER people that only existed because this account
 * existed, and leaving it behind attached to a dead business would be the
 * worst of both worlds.
 *
 * What survives: order_items, orders, lead_fees, suspensions and reviews. Work
 * that happened, money that moved, and what customers said about it.
 */
export async function closeOperatorAccount(
  env: Env, operatorId: string,
): Promise<{ removed: Record<string, number> }> {
  const id = (operatorId ?? '').trim();
  if (!id) throw badRequest('An account needs an operator.', 'no_operator');

  const op = await env.DB.prepare(
    `SELECT id, email, avatar_key, closed_at FROM operators WHERE id = ?`,
  ).bind(id).first<{
    id: string; email: string; avatar_key: string | null; closed_at: number | null;
  }>();
  if (!op) throw notFound('No such account.');
  if (op.closed_at) throw badRequest('That account is already closed.', 'already_closed');

  // Not while somebody is expecting them on Thursday.
  //
  // Closing deletes the conversations, so a customer with a paid booking would
  // lose the thread, the address they gave, the photographs and the only way
  // to reach the business — and find out by nobody arriving. Cancelling those
  // bookings first is a decision with a refund attached, and it belongs to the
  // operator making it rather than to a side effect of this function.
  const live = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM appointments
      WHERE operator_id = ? AND status = 'scheduled' AND ends_at > ?`,
  ).bind(id, now()).first<{ n: number }>();
  if ((live?.n ?? 0) > 0) {
    throw badRequest(
      `You still have ${live!.n} booking${live!.n === 1 ? '' : 's'} in the diary. `
      + 'Cancel or finish those first — closing now would leave those customers '
      + 'with nobody coming and no way to reach you.',
      'live_bookings',
    );
  }

  const removed: Record<string, number> = {};
  const add = (k: string, n: number) => { removed[k] = (removed[k] ?? 0) + n; };
  const t = now();

  // The portfolio, objects first so a failure cannot leave a row pointing at
  // an object that is gone.
  const photos = await env.DB.prepare(
    `SELECT id, r2_key FROM work_photos WHERE operator_id = ?`,
  ).bind(id).all<{ id: string; r2_key: string }>();
  for (const p of photos.results ?? []) {
    if (env.PHOTOS) await env.PHOTOS.delete(p.r2_key).catch(() => {});
  }
  add('work_photos', changes(await env.DB.prepare(
    `DELETE FROM work_photos WHERE operator_id = ?`,
  ).bind(id).run()));
  if (op.avatar_key && env.PHOTOS) await env.PHOTOS.delete(op.avatar_key).catch(() => {});

  // Where they last were, and the trail of where they drove. Not a row, which
  // is exactly why it was being missed. See forgetVan.
  await forgetVan(env, id);

  // Other people's data that only existed because this account did.
  add('threads', changes(await env.DB.prepare(
    `DELETE FROM threads WHERE operator_id = ?`,
  ).bind(id).run()));
  add('clients', changes(await env.DB.prepare(
    `DELETE FROM clients WHERE operator_id = ?`,
  ).bind(id).run()));
  add('instant_requests', changes(await env.DB.prepare(
    `DELETE FROM instant_requests WHERE operator_id = ?`,
  ).bind(id).run()));
  add('messages', changes(await env.DB.prepare(
    `DELETE FROM messages WHERE operator_id = ?`,
  ).bind(id).run()));
  add('notifications', changes(await env.DB.prepare(
    `DELETE FROM notifications WHERE operator_id = ?`,
  ).bind(id).run()));

  // Nobody signs in to this account again, starting now.
  add('sessions', changes(await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE operator_id = ? AND revoked_at IS NULL`,
  ).bind(t, id).run()));
  add('login_tokens', changes(await env.DB.prepare(
    `DELETE FROM login_tokens WHERE operator_id = ?`,
  ).bind(id).run()));

  // The row itself. Emptied, not flagged.
  //
  // The email is set to a value that cannot be a mailbox rather than to NULL,
  // because the column is NOT NULL and carries a unique index: two closed
  // accounts both holding '' would collide and the second close would fail.
  add('operators', changes(await env.DB.prepare(
    `UPDATE operators SET
        email = ?, business_name = 'Closed business', trade = NULL, phone_e164 = NULL,
        home_address = NULL, home_lat = NULL, home_lng = NULL,
        tagline = NULL, bio = NULL, avatar_key = NULL, profile_slug = NULL,
        license_number = NULL, license_state = NULL, license_expires_at = NULL,
        insurer = NULL, policy_number = NULL, insurance_expires_at = NULL,
        background_check_name = NULL, background_check_provider = NULL,
        background_checked_at = NULL,
        vehicle_make = NULL, vehicle_model = NULL, vehicle_color = NULL,
        vehicle_plate = NULL,
        social_instagram = NULL, social_facebook = NULL, social_tiktok = NULL,
        payment_ref = NULL, payment_brand = NULL, payment_last4 = NULL,
        payment_added_at = NULL,
        is_published = 0, accept_public_bookings = 0, share_location = 0,
        online_until = NULL, online_since = NULL,
        plan = 'cancelled', closed_at = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(`closed+${id}@invalid`, t, t, id).run()));

  await recordErasure(env, 'operator', op.email, sum(removed));
  return { removed };
}
