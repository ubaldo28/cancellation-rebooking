import type { Candidate, Env, Operator, Point } from '../types';
import { driveSeconds } from './geo';
import { now } from './util';

export interface GapRow {
  id: string; starts_at: number; ends_at: number;
  prev_lat: number | null; prev_lng: number | null;
  next_lat: number | null; next_lng: number | null;
  baseline_drive_seconds: number | null;
  is_mobile: number; status: string;
}

/**
 * WHO CAN BE OFFERED AN HOUR, AND WHY THE ANSWER HAD TO CHANGE.
 *
 * Until now both candidate queries below required `sms_consent = 1 AND
 * phone_e164 IS NOT NULL`. That is the test from the product this used to be:
 * an operator arrived with their own book of clients, typed in the numbers,
 * ticked the consent box, and the app texted the ones who fitted a hole.
 *
 * The product is a marketplace now, and the two facts that killed those
 * clauses are both deliberate:
 *
 *   1. EVERY CUSTOMER THE OPERATOR EARNS THROUGH THIS SITE IS WRITTEN WITH NO
 *      NUMBER. clientWrite in ./orders.ts and the identical insert in
 *      ./public.ts spell out `phone_e164 NULL, email NULL, sms_consent 0` on
 *      purpose -- the privacy model is that no contact details are exchanged,
 *      and that has to be true of the stored row rather than of the queries
 *      that read it. So the SQL above asked for a column the product promises
 *      never to fill, and every single customer this platform introduced was
 *      permanently ineligible. The feature the dashboard offers -- "fill this
 *      slot from the people who have already used you" -- could not return
 *      one of them, ever.
 *
 *   2. THERE IS NO SMS. Sending to a US mobile needs a registered campaign,
 *      every route to one needs a rentable street address published on the
 *      site plus a card, and the owner has refused both. Migration 0038 moved
 *      the customer's own sign-in off text messages for exactly this reason.
 *      So even the handful of rows that did pass the filter -- an operator's
 *      own imported clients -- were being ranked, shown, and handed to a send
 *      path that could not deliver.
 *
 * WHAT "REACHABLE" MEANS INSTEAD. The same thing it means everywhere else on
 * this site: the two channels the product actually has.
 *
 *   A CONVERSATION. Every booking made through this site opens a thread
 *   between the customer and that business and stamps `threads.client_id`
 *   with the row it just created -- see the end of placeOrder in ./orders.ts
 *   and claimSlot in ./public.ts, which both do it on every path. That thread
 *   is where the offer is delivered, because it is the one place this product
 *   lets these two people talk. A client row with no thread has no channel at
 *   all, which is why the join below is an inner one: it is not a ranking
 *   penalty, it is the difference between an offer and a row nobody is told
 *   about.
 *
 *   A VERIFIED MAILBOX. The thread is a page the customer has to open, so on
 *   its own it is a message sitting in a room nobody is standing in. The
 *   nudge is an email, and the address is the one thing this product knows is
 *   really theirs: `customer_accounts.login_email`, which since migration 0038
 *   IS the account, proved by a code typed back in. It is reached from the
 *   client row through the work -- `order_items.client_id` names the row a
 *   booking created at that business, which is the same key the erasure sweep
 *   in ./retention.ts uses to find them. An account that has been closed or
 *   erased has the column emptied, so those rows fall out here for free.
 *
 *   It is also what makes the opt-out honest. sms_consent used to be both the
 *   permission and the way to withdraw it; the replacement is the one-click
 *   stop link in every offer email (see offerStopToken in ./offers.ts), and a
 *   candidate with no address would be somebody being offered slots with no
 *   way to say stop. So the mailbox is a requirement rather than a bonus.
 *
 * WHAT THIS COSTS, SAID PLAINLY, because it is a real cost and not a
 * rounding error.
 *
 *   An operator's OWN clients -- the book they arrived with, the numbers they
 *   typed in themselves -- are no longer candidates. There is no channel to
 *   them: no thread, no account, and no text messages. That is not a filter
 *   deciding they are unsuitable, it is the truth about what can be sent, and
 *   saying it here is better than ranking somebody the send path then drops.
 *
 *   AND SO IS ANYBODY WHO BOOKED THROUGH claimSlot, the no-JavaScript form at
 *   POST /book/:gapId. They have a conversation and they have proved a mailbox
 *   -- that form will not book without a code -- but that path writes no
 *   `orders` row, so nothing joins their client row to the account, and the
 *   second condition above cannot be met. They are excluded rather than
 *   half-offered, because an offer with no email is an offer with no way to
 *   stop receiving them. Fixing it properly means that path writing an order
 *   like every other booking does, which is a change to the booking flow and
 *   not to this file.
 *
 * The empty state in web/src/pages/FillSlot.tsx says all of this in one
 * sentence, and test/two-trees.test.ts pins the two together.
 *
 * `platform_introduced` is asked for as well, even though a thread and an
 * order between them already imply it. It costs one boolean comparison and it
 * makes the query state its own intent, and it is the flag migration 0048
 * recorded a reader for -- `acquired = 'public'` is set by the same two
 * inserts on the same statement and says the same thing about the same rows.
 * If those two are ever consolidated, consolidate them in one migration rather
 * than letting them drift.
 */

/**
 * This operator's live conversations, one row per customer.
 *
 * Grouped rather than joined straight onto `threads`, for two reasons. A
 * returning customer has more than one thread with the same business -- each
 * booking opens one -- and a plain join would put the same person on the
 * screen once per conversation they have ever had. And SQLite fills a bare
 * column from the row that produced the MAX, which is documented behaviour
 * and exactly what is wanted here: the thread that gets the message is the one
 * they used most recently, not an arbitrary old one.
 *
 * operator_id leads because it is the tenant boundary -- no query against this
 * table is ever allowed to omit it -- and it is also what keeps this to an
 * index seek on idx_threads_operator rather than a scan of every conversation
 * on the site.
 *
 * 'open' only: a closed thread still reads, but it takes no new messages, so
 * posting an offer into one would be writing into a room with the door shut.
 */
const OPEN_THREAD_SQL = `
  SELECT th.client_id AS client_id, th.id AS thread_id,
         MAX(th.last_message_at) AS last_at
    FROM threads th
   WHERE th.operator_id = ?
     AND th.status = 'open'
     AND th.client_id IS NOT NULL
   GROUP BY th.client_id`;

/**
 * The mailbox behind one of this operator's client rows.
 *
 * SHARED WITH ./offers.ts ON PURPOSE, as one string rather than two hand-typed
 * copies. This decides who is offered an hour and that file decides where the
 * email goes; if the two ever disagreed, the difference would be an offer
 * shown to an operator, written to the database and sent to nobody.
 *
 * Three conditions on the account, and each one is a different way of not
 * being there. `closed_at IS NULL` because a closed account must not be
 * mailed. `email_verified_at IS NOT NULL` because nothing is delivered to an
 * address nobody has proved they can read -- the same rule sendAlertEmail in
 * ./alerts.ts states at the point of sending, learned the hard way when a
 * public form would mail a stranger five times a day. `login_email IS NOT
 * NULL` because closing or erasing an account empties the column, and that is
 * the state an erased customer is left in.
 *
 * The address itself is NOT selected here into anything the operator can see.
 * It is read only inside the Worker's send path -- see reachableEmails in
 * ./offers.ts -- for the reason clientWrite gives at length: a contact detail
 * that is never handed out cannot be leaked by a query somebody writes next
 * year.
 */
export const REACHABLE_ACCOUNT_SQL = `
  SELECT oi.client_id AS client_id, a.id AS account_id, a.login_email AS login_email,
         MAX(oi.starts_at) AS last_booked_at
    FROM order_items oi
    JOIN orders o            ON o.id = oi.order_id
    JOIN customer_accounts a ON a.id = o.customer_account_id
   WHERE oi.operator_id = ?
     AND a.closed_at IS NULL
     AND a.email_verified_at IS NOT NULL
     AND a.login_email IS NOT NULL
   GROUP BY oi.client_id`;

/**
 * WHAT AN OPERATOR IS TOLD WHEN THE LIST COMES BACK EMPTY.
 *
 * It sits here, next to the filters it describes, because that is the only
 * place it can be kept true. The sentence it replaces — "Clients need a mobile
 * number and SMS consent" — was advice that could not help: following it was
 * impossible for a customer this site introduced, since the number is never
 * written, and pointless in any case because nothing here sends a text. An
 * empty state that tells somebody to do something that cannot work is worse
 * than one that says nothing, because they will go and try.
 *
 * WRITTEN OUT TWICE, once here and once in web/src/pages/FillSlot.tsx, because
 * the Worker cannot import a browser bundle and this reaches the operator by
 * both routes: as the `reason` on a send that found nobody, and as the empty
 * state on the screen before they press anything. test/two-trees.test.ts pins
 * the two against each other character for character.
 */
export const NOBODY_TO_OFFER =
  'Nobody fits this slot. It can only be offered to customers who booked you '
  + 'through Round The Way — the offer lands in the conversation you already '
  + 'have with them, and in their email. It also needs someone who is not '
  + 'already in your diary, was not offered a slot recently, and whose usual '
  + 'job fits the time.';

/**
 * Ranking weights. Deliberately explicit and summing to 1 so the score stays
 * readable, and so the reason strings shown to the operator match the maths.
 */
const W_PROXIMITY = 0.5;   // can I actually get there and back without wrecking the day
const W_READINESS = 0.35;  // how overdue / how urgent
const W_VALUE = 0.15;      // what the job is worth

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * How late a client is, in words an operator would use.
 *
 * `days` is measured from the client's DUE date (last visit + the service's
 * cadence), never from the last visit itself. Weeks use floor so the label
 * never overstates how late someone is.
 */
export function lateLabel(days: number): string {
  if (days < 0) {
    const ahead = -days;
    return ahead === 1 ? 'due tomorrow' : `due in ${ahead} days`;
  }
  if (days === 0) return 'due today';
  if (days < 14) return `${days} days late`;
  const weeks = Math.floor(days / 7);
  return `${weeks} weeks late`;
}

/**
 * Build and score the candidate list for one gap.
 *
 * Two candidate sources, unioned:
 *   clients — recurring trades: someone overdue for their next visit
 *   leads   — break-fix trades: quoted work that never got booked
 *
 * Hard filters run in SQL (reach, opt-out, cooldown, parts, duration fit).
 * Soft ranking runs here. A candidate that fails a hard filter is never scored,
 * so the operator can trust that everything on screen is actually offerable —
 * and since the sms_consent clauses became the two joins described above,
 * "offerable" means a message this deployment can genuinely deliver rather
 * than a text nobody has ever been able to send.
 */
export async function rankCandidates(
  env: Env, op: Operator, gap: GapRow, limit = 25,
): Promise<Candidate[]> {
  const t = now();
  const gapSeconds = gap.ends_at - gap.starts_at;
  const cooldownBefore = t - op.reoffer_cooldown_seconds;

  const wantClients = op.fill_model === 'clients' || op.fill_model === 'both';
  const wantLeads = op.fill_model === 'leads' || op.fill_model === 'both';

  const rows: any[] = [];

  /*
   * A NOTE ON THE BINDINGS IN BOTH QUERIES BELOW.
   *
   * SQLite numbers `?` by where it appears in the statement text, and the two
   * derived tables sit in the FROM clause -- ahead of every WHERE. So the
   * operator's id is bound THREE times in the clients query and three in the
   * leads one: once for the threads roll-up, once for the orders roll-up, and
   * once for the query's own tenant check. Getting that order wrong does not
   * throw; it silently ranks one operator's customers against another
   * operator's conversations, which is the single worst bug this file could
   * have. Read the binds against the statement, not against this comment.
   */
  if (wantClients) {
    const r = await env.DB.prepare(
      `SELECT 'client' AS kind, c.id AS client_id, NULL AS lead_id,
              s.id AS service_id, c.first_name, c.language, c.lat, c.lng,
              COALESCE(s.duration_seconds, 3600) AS duration_seconds,
              COALESCE(s.price_cents, 0)        AS price_cents,
              COALESCE(s.name, 'Appointment')   AS title,
              c.next_due_at, NULL AS urgency, c.no_show_count,
              COALESCE(s.requires_client_present, 1) AS requires_client_present,
              th.thread_id, acct.account_id
         FROM clients c
         JOIN (${OPEN_THREAD_SQL})       th   ON th.client_id = c.id
         JOIN (${REACHABLE_ACCOUNT_SQL}) acct ON acct.client_id = c.id
         LEFT JOIN services s ON s.id = c.default_service_id AND s.is_active = 1
        WHERE c.operator_id = ?
          AND c.is_active = 1
          AND c.opted_out_at IS NULL
          AND c.platform_introduced = 1
          AND (c.last_offered_at IS NULL OR c.last_offered_at < ?)
          AND COALESCE(s.gap_fill_eligible, 1) = 1
          AND COALESCE(s.duration_seconds, 3600) <= ?
          AND (c.next_due_at IS NULL OR c.next_due_at <= ?)
          AND NOT EXISTS (
                SELECT 1 FROM appointments a
                 WHERE a.client_id = c.id AND a.status = 'scheduled' AND a.starts_at > ?)
        LIMIT 400`,
    ).bind(op.id, op.id, op.id, cooldownBefore, gapSeconds, gap.ends_at, t).all();
    rows.push(...(r.results ?? []));
  }

  if (wantLeads) {
    const r = await env.DB.prepare(
      `SELECT 'lead' AS kind, c.id AS client_id, l.id AS lead_id,
              l.service_id, c.first_name, c.language,
              COALESCE(l.lat, c.lat) AS lat, COALESCE(l.lng, c.lng) AS lng,
              COALESCE(l.estimated_duration_seconds, s.duration_seconds, 3600) AS duration_seconds,
              COALESCE(l.quoted_price_cents, s.price_cents, 0) AS price_cents,
              l.title, NULL AS next_due_at, l.urgency, c.no_show_count,
              COALESCE(s.requires_client_present, 1) AS requires_client_present,
              th.thread_id, acct.account_id
         FROM job_leads l
         JOIN clients c  ON c.id = l.client_id
         JOIN (${OPEN_THREAD_SQL})       th   ON th.client_id = c.id
         JOIN (${REACHABLE_ACCOUNT_SQL}) acct ON acct.client_id = c.id
         LEFT JOIN services s ON s.id = l.service_id
        WHERE l.operator_id = ?
          AND l.status = 'open'
          AND (l.parts_required = 0 OR l.parts_ready = 1)
          AND (l.expires_at IS NULL OR l.expires_at > ?)
          AND (l.last_offered_at IS NULL OR l.last_offered_at < ?)
          AND c.is_active = 1
          AND c.opted_out_at IS NULL
          AND c.platform_introduced = 1
          AND COALESCE(l.estimated_duration_seconds, s.duration_seconds, 3600) <= ?
        LIMIT 400`,
    ).bind(op.id, op.id, op.id, t, cooldownBefore, gapSeconds).all();
    rows.push(...(r.results ?? []));
  }

  if (rows.length === 0) return [];

  // Drive times, but only for mobile gaps with a usable anchor and coordinates.
  const prev: Point | null =
    gap.prev_lat != null && gap.prev_lng != null ? { lat: gap.prev_lat, lng: gap.prev_lng } : null;
  const next: Point | null =
    gap.next_lat != null && gap.next_lng != null ? { lat: gap.next_lat, lng: gap.next_lng } : null;
  const useDriveTime = gap.is_mobile === 1 && (prev !== null || next !== null);

  const pairs: [Point, Point][] = [];
  const pairMap: Array<{ row: number; slot: 'in' | 'out' }> = [];
  if (useDriveTime) {
    rows.forEach((r, i) => {
      if (r.lat == null || r.lng == null) return;
      const p: Point = { lat: r.lat, lng: r.lng };
      if (prev) { pairs.push([prev, p]); pairMap.push({ row: i, slot: 'in' }); }
      if (next) { pairs.push([p, next]); pairMap.push({ row: i, slot: 'out' }); }
    });
  }
  const times = await driveSeconds(env, op.id, pairs);
  const driveIn = new Map<number, number>();
  const driveOut = new Map<number, number>();
  pairMap.forEach((m, n) => {
    (m.slot === 'in' ? driveIn : driveOut).set(m.row, times[n]!);
  });

  const maxPrice = Math.max(1, ...rows.map((r) => Number(r.price_cents) || 0));

  const scored: Candidate[] = [];
  /**
   * Which customer ACCOUNT each client row belongs to, kept beside the scored
   * list rather than on the Candidate itself.
   *
   * It is needed for the de-duplication at the bottom and it is deliberately
   * not part of the payload the operator's browser receives: nothing on that
   * screen has any use for it, and an id that names a person across every
   * business on the site is not something to hand to one of them.
   */
  const accountOf = new Map<string, string>();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const reasons: string[] = [];

    const dIn = driveIn.get(i) ?? null;
    const dOut = driveOut.get(i) ?? null;
    const baseline = gap.baseline_drive_seconds ?? 0;

    let detour: number | null = null;
    let proximity = 0.5;   // neutral when we have no geography to judge on

    if (useDriveTime && (dIn != null || dOut != null)) {
      const travel = (dIn ?? 0) + (dOut ?? 0);
      detour = Math.max(0, travel - baseline);

      // Hard filter: the job plus its travel must physically fit the gap.
      if (r.duration_seconds + travel > gapSeconds) continue;
      // Hard filter: operator's own tolerance for extra driving.
      if (detour > op.max_detour_seconds) continue;

      proximity = clamp01(1 - detour / Math.max(1, op.max_detour_seconds));
      const mins = Math.round(detour / 60);
      reasons.push(mins <= 1 ? 'basically on the way' : `${mins} min extra driving`);
    } else if (gap.is_mobile === 1 && r.lat == null) {
      // Mobile gap, unlocatable client: keep but rank low and say why.
      proximity = 0.15;
      reasons.push('no address on file');
    }

    // Readiness: how overdue (clients) or how urgent (leads).
    let readiness = 0.5;
    let overdueDays: number | null = null;
    if (r.kind === 'client') {
      if (r.next_due_at != null) {
        // Measured from the DUE date, not the last visit. Those differ by the
        // service's cadence, and conflating them is how a client who is
        // actually due next week reads as three weeks overdue.
        overdueDays = Math.floor((t - Number(r.next_due_at)) / 86400);
        readiness = clamp01(overdueDays / 30 + 0.35);
        reasons.push(lateLabel(overdueDays));
      } else {
        // No cadence means "overdue" has no meaning for this client. Say that,
        // rather than inventing a number from the last-visit date.
        readiness = 0.3;
        reasons.push('no repeat set');
      }
    } else {
      const urgency = Number(r.urgency) || 2;
      readiness = clamp01(urgency / 5);
      reasons.push(`open quote, urgency ${urgency}/5`);
    }

    // Short-notice penalty when the customer has to be there in person.
    const noticeSeconds = gap.starts_at - t;
    if (r.requires_client_present === 1 && noticeSeconds < 4 * 3600) {
      readiness *= 0.75;
      reasons.push('short notice, needs them home');
    }

    // Repeat no-shows are a real cost on a slot you are trying to rescue.
    if (Number(r.no_show_count) > 0) {
      readiness *= Math.max(0.4, 1 - Number(r.no_show_count) * 0.2);
      reasons.push(`${r.no_show_count} previous no-show(s)`);
    }

    const value = clamp01(Number(r.price_cents) / maxPrice);

    const score = W_PROXIMITY * proximity + W_READINESS * readiness + W_VALUE * value;

    if (r.account_id) accountOf.set(r.client_id, String(r.account_id));

    scored.push({
      kind: r.kind,
      client_id: r.client_id,
      lead_id: r.lead_id ?? null,
      service_id: r.service_id ?? null,
      first_name: r.first_name,
      // The conversation this offer will be delivered into. It is on the
      // candidate rather than looked up again at send time so that the row
      // which passed the reachability join is the row that gets written to --
      // a second lookup is a second chance to pick a different thread, or
      // none, between the operator seeing a name and pressing send.
      thread_id: String(r.thread_id),
      language: r.language ?? null,
      lat: r.lat, lng: r.lng,
      duration_seconds: Number(r.duration_seconds),
      price_cents: Number(r.price_cents),
      title: r.title,
      overdue_days: overdueDays,
      urgency: r.urgency != null ? Number(r.urgency) : null,
      drive_in_seconds: dIn,
      drive_out_seconds: dOut,
      detour_seconds: detour,
      score,
      reasons,
    });
  }

  /*
   * Never offer the same person twice for one gap; the client row wins over a
   * lead row only if it scores higher.
   *
   * KEYED ON THE ACCOUNT AND NOT ON THE CLIENT ROW, which matters more than it
   * used to. A client row is created per BOOKING -- placeOrder mints a fresh
   * one for each business in each basket and never looks for an existing row
   * -- so a customer who has used the same operator four times is four rows on
   * that operator's list, each with its own conversation. Keyed on client_id
   * this loop would have shown that one person four times and, worse, sent
   * them four separate offers for the same hour, in four separate threads,
   * each with its own accept link racing the others. The account is the
   * person; the client rows are the paperwork.
   *
   * The fallback to client_id is for a row whose account could not be read
   * back for some reason. It cannot happen while the reachability join above
   * is an inner one, and it is one character of insurance against a future
   * where it is not.
   */
  const bestPerPerson = new Map<string, Candidate>();
  for (const c of scored) {
    const key = accountOf.get(c.client_id) ?? c.client_id;
    const existing = bestPerPerson.get(key);
    if (!existing || c.score > existing.score) bestPerPerson.set(key, c);
  }

  return [...bestPerPerson.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
