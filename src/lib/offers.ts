import type { Candidate, Env, Operator } from '../types';
import { hashOfferToken } from './auth';
import { discounted, formatMoney, localeFor } from './countries';
import { sendEmail, type Email } from './email';
import { copy, pickLang } from './messages';
import { REACHABLE_ACCOUNT_SQL, type GapRow } from './rank';
import { formatTimeRange } from './tz';
import {
  conflict, escapeHtml, newId, newToken, notFound, now, timingSafeEqual,
} from './util';

/**
 * HOW AN OFFER REACHES THE PERSON IT IS FOR.
 *
 * It used to be a text message, and that is the whole reason this feature has
 * never worked. The Worker never sent one itself: it handed the operator a
 * prefilled `sms:` link to tap on their own handset, wrote a row into the
 * `messages` table to record that it had done so, and called that delivery.
 * Two things were wrong with it by the time the product became a marketplace.
 *
 *   The people it could be sent to did not exist. A candidate needed a mobile
 *   number and an SMS consent flag, and every customer this site introduces is
 *   written with neither, on purpose -- no contact details are exchanged here.
 *   See the rewritten queries in ./rank.ts.
 *
 *   And there is no SMS. Not "not configured yet": a US route needs a
 *   registered campaign behind a rentable street address published on the
 *   site, and that is a settled no. ./sms.ts stays for the sign-in code path
 *   it was hardened for; nothing in this file goes near it.
 *
 * SO AN OFFER IS DELIVERED THE WAY EVERYTHING ELSE ON THIS SITE IS.
 *
 *   1. A MESSAGE IN THE CONVERSATION THEY ALREADY HAVE. Every booking opens a
 *      thread between that customer and that business, and it is where the
 *      two of them have talked about this job before. The write goes in the
 *      SAME D1 batch as the offer row, for the reason chatWrites in
 *      ./estimates.ts gives: a message with no offer behind it is the site
 *      telling somebody about an hour that was never held, and an offer with
 *      no message is a row nobody was ever told about -- which is precisely
 *      the state every offer this product has ever written ended up in.
 *
 *   2. AN EMAIL, ON THE BULK LANE. The thread is a page somebody has to open,
 *      so on its own it is a note left in an empty room. The nudge goes to the
 *      address that IS their account since migration 0038, through
 *      BULK_EMAIL_PROVIDER -- the same lane as the opening alerts, for the
 *      same reason: this is the half of the site's email that grows with how
 *      busy it is, and it must not spend the allowance the sign-in links need.
 *      A sign-in link never goes this way and none is sent from here; what
 *      travels is the offer link, which is bearer authority over exactly one
 *      offer and nothing else.
 *
 * WHICH OF THE TWO IS THE DELIVERY. The message is. It lands inside the
 * transaction, so it either exists or the whole wave rolled back. The email is
 * sent afterwards, cannot be part of a transaction, and is allowed to fail --
 * an offer whose nudge bounced is still an offer sitting in the conversation.
 * `emailed` on the result says which happened rather than leaving the operator
 * to assume.
 */

const money = (cents: number, currency: string, locale: string) =>
  formatMoney(cents, currency, locale);

/**
 * What the customer reads, in their own language.
 *
 * One string for both lanes on purpose: the email is the nudge and the thread
 * is the record, and two wordings of the same offer would be two prices and
 * two times to reconcile when somebody quotes one back at the business.
 *
 * NO "Reply STOP" line any more. It was a carrier instruction printed on a
 * message no carrier carries; in a chat bubble it is advice that does nothing
 * at all. Stopping these is a one-click link, and it rides on the email --
 * see offerEmail below.
 */
export function buildMessage(
  op: Operator, cand: Candidate, gap: GapRow, url: string,
): string {
  const lang = pickLang(cand.language ?? null, op.language ?? null);
  const t = copy(lang);
  const locale = localeFor(op.country, lang);
  const when = formatTimeRange(gap.starts_at, gap.starts_at + cand.duration_seconds, op.timezone, locale);
  // The shared rounding, not a percentage worked out here. See ./countries.
  const offered = discounted(cand.price_cents, op.discount_percent, op.currency);

  const price = cand.price_cents > 0
    ? op.discount_percent > 0
      ? ` ${money(offered, op.currency, locale)} (${op.discount_percent}% off)`
      : ` ${money(offered, op.currency, locale)}`
    : '';

  return t.offer({
    name: cand.first_name,
    business: op.business_name,
    when,
    price: price.trim(),
    service: cand.title,
    url,
  });
}

/**
 * THE WAY OUT, AND WHY IT IS NOT THE ALERTS' UNSUBSCRIBE.
 *
 * sms_consent was two things at once: the permission to send and the record of
 * it being withdrawn. Dropping it from the candidate queries drops both, and a
 * product that offers somebody an hour with no way to say "stop offering me
 * hours" is worse than one that cannot offer at all.
 *
 * unsubscribeByToken in ./alerts.ts is the right SHAPE and the wrong subject.
 * It switches off a row in `watches` -- a standing request a stranger made for
 * themselves -- and there is no watch here to switch off. The thing that has
 * to stop is offers from one business to one of their past customers, and the
 * column that already means exactly that is `clients.opted_out_at`, which both
 * queries in ./rank.ts have always filtered on. So the mechanism is borrowed
 * and the subject is the client row.
 *
 * What is borrowed is the part that matters: a SINGLE-PURPOSE key, derived
 * rather than random, whose only power is switching itself off. The reason
 * alerts derive theirs is that the matcher sends mail weeks after the watch
 * was made and only a hash of the random token was kept -- a hash does not run
 * backwards. The same is true here: this link has to be reproducible by every
 * future wave, and the offer's own token cannot do it because it is minted per
 * offer, expires in hours, and is authority to BOOK.
 *
 * WHAT IS DIFFERENT, AND IT IS AN IMPROVEMENT ON THE WATCH VERSION. A watch
 * stores the hash of its stop key in a column; this stores nothing at all. The
 * token is the client's id and a digest of that id under the server pepper, so
 * the route recomputes the digest and compares. A read-only copy of the
 * database yields no working stop links because there are none in it, and no
 * migration was needed to add a column to carry them.
 *
 * The id being visible in the link is not a leak: it is a random identifier
 * that names a row in one operator's client list, it reveals nothing on its
 * own, and without SESSION_PEPPER nobody can turn it into a working link.
 */
export const offerStopToken = async (env: Env, clientId: string): Promise<string> =>
  `${clientId}.${await hashOfferToken(`client-offer-stop:${clientId}`, env)}`;

/**
 * Switches offers off from the link at the bottom of an offer email.
 *
 * Deliberately does nothing else. It cannot read the client row, change an
 * address or say whose it is — the only outcome is that this business stops
 * offering this person their spare hours, which is what the person clicking it
 * asked for. Everything else about the relationship, including the bookings
 * they have already made and the conversation they are in, is untouched.
 *
 * Answers false for anything that does not match, including a blank token, so
 * that a caller cannot accidentally opt out "the client whose digest is the
 * digest of the empty string".
 */
export async function stopOffersByToken(env: Env, token: string): Promise<boolean> {
  const raw = (token ?? '').trim();
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return false;

  const clientId = raw.slice(0, dot);
  const presented = raw.slice(dot + 1);
  const expected = await hashOfferToken(`client-offer-stop:${clientId}`, env);
  // Constant time, for the reason mayEchoSignInLink gives about the debug
  // token: `!==` on a digest returns at the first differing byte, so how long
  // the refusal takes measures how much of the answer the caller already has.
  if (!timingSafeEqual(presented, expected)) return false;

  const res = await env.DB.prepare(
    `UPDATE clients SET opted_out_at = ?, updated_at = ?
      WHERE id = ? AND opted_out_at IS NULL`,
  ).bind(now(), now(), clientId).run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * The mailbox behind each of these client rows.
 *
 * The same roll-up ./rank.ts joined on to decide who was a candidate at all,
 * re-run here over just the wave, so that the address is read in the one place
 * that actually sends and never travels to a browser. It is re-run rather than
 * carried on the Candidate for two reasons: a candidate list can sit on an
 * operator's screen for minutes before they press send, and an account closed
 * in between must not be mailed; and a contact detail that is never put in a
 * response body cannot be leaked by a response body.
 *
 * Reading the fragment from ./rank.ts rather than typing the joins out again
 * is what stops the two ever disagreeing. A difference between them would not
 * be a caught error — it would be a candidate the operator was shown, chose,
 * and whose offer went to nobody.
 */
async function reachableEmails(
  env: Env, operatorId: string, clientIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (clientIds.length === 0) return out;
  const holes = clientIds.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT client_id, login_email FROM (${REACHABLE_ACCOUNT_SQL})
      WHERE client_id IN (${holes})`,
  ).bind(operatorId, ...clientIds).all<{ client_id: string; login_email: string }>();
  for (const r of rows.results ?? []) out.set(r.client_id, r.login_email);
  return out;
}

/**
 * What the nudge says.
 *
 * Shaped like alertEmail in ./alerts.ts — the facts as a list, one link that
 * does the thing, and a stop link that is always present — because they are
 * the same kind of message to the same kind of reader and two house styles for
 * "a business near you has an hour free" would be two things to maintain.
 *
 * The one line it has that the alert does not is why this arrived: an alert
 * was asked for and this was not, so it says which business it is from and
 * that they were booked with before. Somebody who has forgotten the booking is
 * exactly who needs telling.
 */
function offerEmail(
  op: Operator, cand: Candidate, gap: GapRow, to: string, url: string, stopUrl: string,
): Email {
  const lang = pickLang(cand.language ?? null, op.language ?? null);
  const t = copy(lang);
  const locale = localeFor(op.country, lang);
  const when = formatTimeRange(
    gap.starts_at, gap.starts_at + cand.duration_seconds, op.timezone, locale);
  const offered = discounted(cand.price_cents, op.discount_percent, op.currency);

  const facts: Array<[string, string]> = [
    [t.offerEmailFacts.what, cand.title],
    [t.offerEmailFacts.when, when],
    // No price line at all when the job has no price on it, rather than a
    // label with an empty value or a zero. A service an operator has not
    // priced is one they quote per job, and printing "$0.00" beside it is the
    // one number that is certainly wrong.
    ...(cand.price_cents > 0
      ? [[t.offerEmailFacts.price, op.discount_percent > 0
          ? `${money(offered, op.currency, locale)} (${op.discount_percent}% off)`
          : money(offered, op.currency, locale)] as [string, string]]
      : []),
  ];

  const opening = t.offerEmailOpening({ name: cand.first_name, business: op.business_name });
  const why = t.offerEmailWhy({ business: op.business_name });
  const stop = t.stopOffers({ url: stopUrl });

  return {
    to,
    subject: t.offerEmailSubject({ business: op.business_name, when }),
    text: [
      opening,
      '',
      ...facts.map(([k, v]) => `${k}: ${v}`),
      '',
      `${t.firstToConfirm} ${url}`,
      '',
      why,
      '',
      stop,
    ].join('\n'),
    html:
      `<p>${escapeHtml(opening)}</p>`
      + `<ul>${facts.map(([k, v]) =>
        `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</li>`).join('')}</ul>`
      + `<p><a href="${escapeHtml(url)}">${escapeHtml(t.yesBookMe)}</a></p>`
      + `<p style="color:#666;font-size:14px">${escapeHtml(t.firstToConfirm)}</p>`
      + `<p style="color:#666;font-size:14px">${escapeHtml(why)}</p>`
      + `<p style="color:#666;font-size:14px">${escapeHtml(stop)}</p>`,
  };
}

export interface CreatedOffer {
  offer_id: string;
  client_id: string;
  first_name: string;
  url: string;
  message: string;
  /**
   * The conversation the message landed in. The operator's own inbox reads
   * this table, so this is the id of a thread they can open and see the offer
   * sitting in — which is the point: nothing was handed to them to send.
   */
  thread_id: string;
  /**
   * Whether the nudge email actually left. False means the offer is in their
   * conversation and nothing has pinged them about it, which is a smaller
   * thing than a failed send but is still not the same as delivered, and the
   * operator is told rather than left to assume.
   */
  emailed: boolean;
  rank: number;
  score: number;
  reasons: string[];
}

/**
 * Send a wave of offers for a gap.
 *
 * SENDS, RATHER THAN PREPARING TO SEND. The old version returned `sms:` links
 * for the operator to tap one at a time on their own phone, which meant the
 * offer rows said 'sent' whether or not they ever did it, and on a deployment
 * with no SMS at all it meant nobody was ever told anything. Everything here
 * happens server-side: the message is written into each customer's
 * conversation inside the same transaction as the offer, and the email goes
 * out immediately afterwards.
 *
 * Marks the gap 'offering' so a concurrent detection pass will not expire it
 * out from under the live offers.
 */
export async function createOffers(
  env: Env, op: Operator, gap: GapRow, candidates: Candidate[],
): Promise<CreatedOffer[]> {
  if (candidates.length === 0) return [];
  const t = now();
  const expiresAt = Math.min(t + op.offer_ttl_seconds, gap.starts_at);

  /*
   * The addresses, read BEFORE anything is written.
   *
   * Order matters in one direction only: if this read throws, nothing has been
   * written and no offer exists, which is the failure worth having. Doing it
   * after the batch would mean rows saying 'sent' for a wave whose recipients
   * could not be looked up.
   */
  const emails = await reachableEmails(env, op.id, candidates.map((c) => c.client_id));

  /**
   * The offer rows this gap already has, so a second wave keeps their ids.
   *
   * The INSERT below is an upsert on (gap_id, client_id, lead_id): re-offering
   * the same opening to the same person is meant to refresh their row rather
   * than make a second one. But a conflicting insert does NOT take the id it
   * was given -- the existing row keeps its own -- while the `messages` row
   * written a few lines further down was bound to the freshly minted one. That
   * id names no offer, messages.offer_id is a foreign key onto gap_offers, and
   * a batch is one transaction: the constraint failed and the WHOLE wave was
   * rolled back. An operator re-sending an opening after a decline, or after
   * the first offers expired, got a 500 and nobody was texted at all.
   *
   * Reading the ids first is one query for the whole wave, and it makes the
   * upsert address the row it is actually going to update. The `messages` row
   * that made the failure so expensive is gone -- see the chat write below --
   * but the id still has to be the existing one, because a second wave must
   * refresh the offer somebody is holding rather than mint a rival to it.
   */
  const held = await env.DB.prepare(
    `SELECT id, client_id, lead_id FROM gap_offers WHERE gap_id = ?`,
  ).bind(gap.id).all<{ id: string; client_id: string; lead_id: string | null }>();
  const heldIds = new Map<string, string>();
  for (const r of held.results ?? []) heldIds.set(`${r.client_id}:${r.lead_id ?? ''}`, r.id);

  const out: CreatedOffer[] = [];
  const writes: D1PreparedStatement[] = [];
  /** The raw offer token and the address for each wave member, for the sends below. */
  const pending: Array<{ cand: Candidate; to: string; url: string }> = [];

  for (const c of candidates) {
    /*
     * A CANDIDATE WITH NO CHANNEL IS NOT OFFERED AT ALL.
     *
     * rankCandidates joins on both of these, so in the ordinary path neither
     * miss is possible. This is here because an offer row is written a few
     * lines below with status 'sent', and 'sent' has to mean somebody was
     * told: the previous version wrote that word for every candidate handed to
     * it and left delivery to whether the operator got round to tapping a
     * link. Skipping is also the right answer for the race this cannot
     * otherwise see -- a customer who closed their account, or a conversation
     * that was closed, between the operator reading the list and pressing
     * send.
     */
    const to = emails.get(c.client_id);
    if (!c.thread_id || !to) continue;

    const raw = newToken(24);
    const url = `${env.APP_URL.replace(/\/$/, '')}/o/${raw}`;
    const message = buildMessage(op, c, gap, url);
    // The row this candidate already has on this gap, or a new one. Either way
    // it is the id the upsert leaves behind, so everything below can use it.
    const offerId = heldIds.get(`${c.client_id}:${c.lead_id ?? ''}`) ?? newId();
    // The same rounding the public listing and checkout apply. This used to be
    // a bare percentage, so an invited client was quoted -- and charged, since
    // acceptOffer copies this onto the appointment -- a figure with stray cents
    // that nobody else on the site would ever see. See ./countries.
    const quoted = discounted(c.price_cents, op.discount_percent, op.currency);

    writes.push(env.DB.prepare(
      `INSERT INTO gap_offers
         (id, operator_id, gap_id, candidate_kind, client_id, lead_id, service_id,
          rank, drive_in_seconds, drive_out_seconds, detour_seconds, overdue_days,
          urgency, score, token_hash, status, sent_at, expires_at,
          quoted_price_cents, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'sent',?,?,?,?,?)
       ON CONFLICT (gap_id, client_id, COALESCE(lead_id, '')) DO UPDATE SET
         rank = excluded.rank, score = excluded.score,
         drive_in_seconds = excluded.drive_in_seconds,
         drive_out_seconds = excluded.drive_out_seconds,
         detour_seconds = excluded.detour_seconds,
         token_hash = excluded.token_hash,
         status = 'sent', sent_at = excluded.sent_at,
         -- Refreshed with the rest of the wave, because buildMessage has just
         -- put this figure in the text the customer is about to read and
         -- acceptOffer copies it onto the appointment. A row left holding the
         -- previous wave's price would book them at a number their message
         -- never mentioned.
         quoted_price_cents = excluded.quoted_price_cents,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    ).bind(
      offerId, op.id, gap.id, c.kind, c.client_id, c.lead_id, c.service_id,
      out.length + 1, c.drive_in_seconds, c.drive_out_seconds, c.detour_seconds,
      c.overdue_days, c.urgency, c.score, await hashOfferToken(raw, env),
      t, expiresAt, quoted, t, t,
    ));

    writes.push(env.DB.prepare(
      `UPDATE clients SET last_offered_at = ?, updated_at = ? WHERE id = ? AND operator_id = ?`,
    ).bind(t, t, c.client_id, op.id));

    if (c.lead_id) {
      writes.push(env.DB.prepare(
        `UPDATE job_leads SET status = 'offered', last_offered_at = ?, updated_at = ?
          WHERE id = ? AND operator_id = ? AND status = 'open'`,
      ).bind(t, t, c.lead_id, op.id));
    }

    /*
     * THE DELIVERY ITSELF, in the same batch as the offer it is about.
     *
     * This replaces a row in `messages`, which was the SMS pipeline's send
     * log: a table whose rows exist because a carrier charged for them, with a
     * `to_address` column that held the customer's phone number. Writing the
     * in-app conversation into it would be wrong twice over -- migration 0011
     * separated the two precisely so a free thread could never be mistaken for
     * a billable send, and `to_address` on an operator-scoped table is a copy
     * of a contact detail this product promises the operator never gets. So
     * the offer is a chat message, and `messages` keeps no row for it at all;
     * the record that it went is the transcript line the customer can read
     * back, plus gap_offers.sent_at.
     *
     * The unread counter goes to the guest, because they are the side with
     * something new to read. Both statements are scoped by operator_id as well
     * as by id: the thread came off a candidate this operator was shown, and
     * scoping it anyway is what makes that true of the statement rather than
     * of the caller.
     *
     * NOT PUT THROUGH redactContact, unlike anything a person types into a
     * thread, and that is a decision rather than an omission. This body is
     * composed here out of the business name, the service name, a time and a
     * price -- fields that are already on the public listing for anybody to
     * read -- plus a link this function has just minted. The filter looks for
     * digit runs, and the offer token is 24 random bytes: one unlucky token
     * would be silently mangled and the customer would tap a link that opens
     * nothing. The same reasoning is why parts.ts redacts the operator's
     * description at INPUT and not the sentence it wraps around it.
     */
    writes.push(env.DB.prepare(
      `INSERT INTO chat_messages (id, thread_id, sender, body, created_at)
       SELECT ?,?, 'operator', ?, ?
        WHERE EXISTS (SELECT 1 FROM threads
                       WHERE id = ? AND operator_id = ? AND status = 'open')`,
    ).bind(newId(), c.thread_id, message, t, c.thread_id, op.id));

    writes.push(env.DB.prepare(
      `UPDATE threads
          SET last_message_at = ?, guest_unread = guest_unread + 1, updated_at = ?
        WHERE id = ? AND operator_id = ? AND status = 'open'`,
    ).bind(t, t, c.thread_id, op.id));

    pending.push({ cand: c, to, url });

    out.push({
      offer_id: offerId,
      client_id: c.client_id,
      first_name: c.first_name,
      url, message,
      thread_id: c.thread_id,
      // Overwritten below, once the send has actually been attempted. It
      // starts false so that a throw between here and there cannot leave
      // anybody looking at a screen claiming an email went.
      emailed: false,
      rank: out.length + 1,
      score: c.score,
      reasons: c.reasons,
    });
  }

  // Everybody in this wave turned out to be unreachable. Nothing is written at
  // all -- not even the gap's 'offering' status, which would otherwise say an
  // opening was being worked on when no message exists anywhere.
  if (out.length === 0) return [];

  writes.push(env.DB.prepare(
    `UPDATE gaps SET status = 'offering', updated_at = ? WHERE id = ? AND status = 'open'`,
  ).bind(t, gap.id));

  await env.DB.batch(writes);

  /*
   * THE NUDGES, after the transaction and never inside it.
   *
   * A network call cannot be part of a D1 batch, and it must not be able to
   * undo one either: an offer that is sitting in somebody's conversation has
   * been made, whatever the mail provider says thirty seconds later. So a
   * refusal is recorded on the result and logged, and the wave stands.
   *
   * Sequential rather than Promise.all, deliberately. This is the same
   * provider and the same per-second window ./email.ts sleeps against, and
   * three offers fired at once is the shape that earns a 429 for two of them.
   * A wave is `offers_per_wave` long -- a handful -- so the wall time is not
   * the thing worth optimising here.
   *
   * The reason and never `detail` in the log: the provider's error text names
   * the sending domain and usually the mailbox it refused, and a Worker log is
   * the one store in this product that no sweep and no erasure can reach.
   */
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i]!;
    const stopUrl =
      `${env.APP_URL.replace(/\/$/, '')}/a/stop-offers/${await offerStopToken(env, p.cand.client_id)}`;
    const result = await sendEmail(
      env, offerEmail(op, p.cand, gap, p.to, p.url, stopUrl), 'bulk');
    out[i]!.emailed = result.sent;
    if (!result.sent) {
      console.error(`offer ${out[i]!.offer_id}: nudge email not sent`, result.reason);
    }
  }

  return out;
}

export interface OfferView {
  offer_id: string; gap_id: string; operator_id: string;
  status: string; expires_at: number | null;
  starts_at: number; ends_at: number; gap_status: string;
  first_name: string; client_id: string; lead_id: string | null;
  service_id: string | null; quoted_price_cents: number | null;
  business_name: string; timezone: string; currency: string; country: string;
  duration_seconds: number; title: string;
  lat: number | null; lng: number | null;
  address_line: string | null; postcode: string | null;
}

export async function loadOfferByToken(env: Env, raw: string): Promise<OfferView> {
  const row = await env.DB.prepare(
    `SELECT o.id AS offer_id, o.gap_id, o.operator_id, o.status, o.expires_at,
            o.client_id, o.lead_id, o.service_id, o.quoted_price_cents,
            g.starts_at, g.ends_at, g.status AS gap_status,
            c.first_name,
            COALESCE(l.lat, c.lat) AS lat, COALESCE(l.lng, c.lng) AS lng,
            COALESCE(l.address_line, c.address_line) AS address_line,
            COALESCE(l.postcode, c.postcode) AS postcode,
            COALESCE(l.estimated_duration_seconds, s.duration_seconds, 3600) AS duration_seconds,
            COALESCE(l.title, s.name, 'Appointment') AS title,
            op.business_name, op.timezone, op.currency, op.country
       FROM gap_offers o
       JOIN gaps g      ON g.id = o.gap_id
       JOIN clients c   ON c.id = o.client_id
       JOIN operators op ON op.id = o.operator_id
       LEFT JOIN job_leads l ON l.id = o.lead_id
       LEFT JOIN services s  ON s.id = o.service_id
      WHERE o.token_hash = ?`,
  ).bind(await hashOfferToken(raw, env)).first<OfferView>();
  if (!row) throw notFound('This link is not valid.');
  return row;
}

/**
 * Accept an offer. Safe against two clients tapping at the same instant:
 * the whole thing is one D1 batch (a single transaction), and the partial
 * unique index `idx_offers_one_accept` makes a second accepted row on the same
 * gap impossible. The loser's batch fails and they get told it just went.
 */
export async function acceptOffer(env: Env, raw: string) {
  const t = now();
  const offer = await loadOfferByToken(env, raw);

  if (offer.status === 'accepted') return { alreadyYours: true, offer };
  if (!['sent', 'delivered', 'viewed', 'queued'].includes(offer.status)) {
    throw conflict('This offer is no longer open.', 'offer_closed');
  }
  if (offer.expires_at != null && offer.expires_at <= t) {
    throw conflict('This offer has expired.', 'offer_expired');
  }
  // Any status but 'open' or 'offering' means the opening is gone, not only
  // 'filled'. An 'expired' gap — withdrawn by the operator, or dropped by a
  // detection pass because the calendar filled up another way — used to sail
  // through this check and still book an appointment on top of whatever now
  // occupies that hour.
  if (!['open', 'offering'].includes(offer.gap_status)) {
    throw conflict('Sorry — that slot has just been taken.', 'slot_taken');
  }
  if (offer.starts_at <= t) {
    throw conflict('That slot has already started.', 'slot_passed');
  }

  const apptId = newId();
  const endsAt = Math.min(offer.starts_at + offer.duration_seconds, offer.ends_at);

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE gap_offers SET status='accepted', responded_at=?, updated_at=?
        WHERE id=? AND status IN ('sent','delivered','viewed','queued')`,
    ).bind(t, t, offer.offer_id),

    // Conditional on the opening still being for sale, so a lost race writes
    // no appointment at all rather than one this function then has to
    // apologise for. The batch is a transaction, but a transaction commits
    // what its statements matched — an unguarded INSERT inside it still lands.
    env.DB.prepare(
      `INSERT INTO appointments
         (id, operator_id, client_id, service_id, lead_id, starts_at, ends_at,
          is_mobile, address_line, postcode, lat, lng, status, price_cents,
          source, filled_offer_id, created_at, updated_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?, 'scheduled', ?, 'gap_fill', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM gaps
                       WHERE id = ? AND status IN ('open','offering'))`,
    ).bind(
      apptId, offer.operator_id, offer.client_id, offer.service_id, offer.lead_id,
      offer.starts_at, endsAt, 1, offer.address_line, offer.postcode,
      offer.lat, offer.lng, offer.quoted_price_cents, offer.offer_id, t, t,
      offer.gap_id,
    ),

    env.DB.prepare(
      `UPDATE gaps SET status='filled', filled_appointment_id=?, updated_at=?
        WHERE id=? AND status IN ('open','offering')`,
    ).bind(apptId, t, offer.gap_id),

    env.DB.prepare(
      `UPDATE gap_offers SET status='superseded', updated_at=?
        WHERE gap_id=? AND id<>? AND status IN ('candidate','queued','sent','delivered','viewed')`,
    ).bind(t, offer.gap_id, offer.offer_id),
  ];

  if (offer.lead_id) {
    statements.push(env.DB.prepare(
      `UPDATE job_leads SET status='scheduled', updated_at=? WHERE id=?`,
    ).bind(t, offer.lead_id));
  }

  try {
    const res = await env.DB.batch(statements);
    // Both guards, not just the offer's. The gap read above is a separate round
    // trip, so the opening can be filled or withdrawn between it and this
    // batch; the appointment INSERT sits between the two guarded statements and
    // is not itself conditional, so without this check the loser of that race
    // walks away with an appointment on an hour somebody else already has.
    if ((res[0]?.meta.changes ?? 0) === 0 || (res[2]?.meta.changes ?? 0) === 0) {
      throw conflict('Sorry — that slot has just been taken.', 'slot_taken');
    }
  } catch (err) {
    // The unique index fired: someone else accepted microseconds earlier.
    if (String(err).includes('UNIQUE') || String(err).includes('constraint')) {
      throw conflict('Sorry — that slot has just been taken.', 'slot_taken');
    }
    throw err;
  }

  return { alreadyYours: false, offer, appointment_id: apptId, ends_at: endsAt };
}

export async function declineOffer(env: Env, raw: string, reason: string | null) {
  const t = now();
  const offer = await loadOfferByToken(env, raw);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE gap_offers SET status='declined', responded_at=?, decline_reason=?, updated_at=?
        WHERE id=? AND status IN ('sent','delivered','viewed','queued')`,
    ).bind(t, reason, t, offer.offer_id),
    env.DB.prepare(
      `UPDATE job_leads SET status='open', updated_at=?
        WHERE id=? AND status='offered'`,
    ).bind(t, offer.lead_id ?? ''),
  ]);
  return offer;
}

export async function markViewed(env: Env, offerId: string) {
  await env.DB.prepare(
    `UPDATE gap_offers SET status='viewed', viewed_at=?, updated_at=?
      WHERE id=? AND status IN ('sent','delivered')`,
  ).bind(now(), now(), offerId).run();
}
