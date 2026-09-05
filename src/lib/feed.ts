import type { Env } from '../types';
import { newId, now } from './util';

/** What kinds of thing the feed carries. Mirrors the CHECK in migration 0021. */
export type NotificationKind =
  | 'public_booking' | 'offer_accepted' | 'booking_cancelled'
  /** A customer wrote to the operator. Not a booking; it needs its own row. */
  | 'chat_message'
  /**
   * A customer answered a parts quote, either way. Its own kind because a
   * decline is as urgent as an approval -- it is the cue to stop and talk, not
   * to fit anything -- and an operator standing next to a car waiting on that
   * answer must not have to find it behind a generic message label.
   */
  | 'parts_quote';

/** One thing that happened to the operator's day. */
export interface Notification {
  id: string;
  operator_id: string;
  kind: string;
  title: string;
  body: string | null;
  appointment_id: string | null;
  claim_id: string | null;
  /** The conversation this came from, so the Inbox can open it. */
  thread_id: string | null;
  /** When the job is, not when this arrived. */
  starts_at: number | null;
  read_at: number | null;
  created_at: number;
}

export interface NotifyInput {
  kind: NotificationKind;
  title: string;
  body?: string | null;
  appointment_id?: string | null;
  claim_id?: string | null;
  thread_id?: string | null;
  starts_at?: number | null;
}

/** A page nobody scrolls to the end of. Also the cap on a runaway query. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * How many ids one markRead statement carries.
 *
 * SQLite refuses a statement past its bound-parameter limit, so a mark-read of
 * a long list is split rather than allowed to fail on the operator who has the
 * most to read.
 */
const ID_CHUNK = 100;

const SELECT_FIELDS =
  `id, operator_id, kind, title, body, appointment_id, claim_id, thread_id,
   starts_at, read_at, created_at`;

/**
 * Records one thing that happened, for the operator to find later.
 *
 * This never throws. It is called from inside booking flows, and a notification
 * that fails to insert must not take the booking down with it: a lost
 * notification is bad, a lost booking is worse. The caller gets on with the
 * thing that actually earns money, and the operator finds out from the calendar
 * this once.
 */
export async function notify(
  env: Env, operatorId: string, input: NotifyInput,
): Promise<void> {
  try {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO notifications (id, operator_id, kind, title, body,
         appointment_id, claim_id, thread_id, starts_at, read_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,?)`,
    ).bind(newId(), operatorId, input.kind, input.title, input.body ?? null,
      input.appointment_id ?? null, input.claim_id ?? null, input.thread_id ?? null,
      input.starts_at ?? null, t).run();
  } catch {
    // Swallowed on purpose. See above: the booking is the thing that must
    // survive. Nothing here is worth rolling one back for.
  }
}

/**
 * The operator's feed, newest first.
 *
 * operator_id is in the WHERE clause rather than checked by the caller, the
 * same as everywhere else in this codebase — that is the whole tenant boundary
 * and it is not optional.
 */
export async function listNotifications(
  env: Env, operatorId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<Notification[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);

  const rows = opts.unreadOnly
    ? await env.DB.prepare(
        `SELECT ${SELECT_FIELDS} FROM notifications
          WHERE operator_id = ? AND read_at IS NULL
          -- rowid, not id: ids are random and created_at is only
          -- accurate to the second, so same-second rows would
          -- otherwise come back in arbitrary order.
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`,
      ).bind(operatorId, limit).all<Notification>()
    : await env.DB.prepare(
        `SELECT ${SELECT_FIELDS} FROM notifications
          WHERE operator_id = ?
          -- rowid, not id: ids are random and created_at is only
          -- accurate to the second, so same-second rows would
          -- otherwise come back in arbitrary order.
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`,
      ).bind(operatorId, limit).all<Notification>();

  return rows.results ?? [];
}

/** How many the operator has not seen. Drives the badge, so it stays one row. */
export async function unreadCount(env: Env, operatorId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notifications
      WHERE operator_id = ? AND read_at IS NULL`,
  ).bind(operatorId).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Marks the given notifications read.
 *
 * Ids belonging to another operator update nothing, because operator_id is in
 * the WHERE clause alongside them. An id copied from somebody else's feed is
 * silently a no-op rather than an error, so nothing here confirms whether that
 * id exists at all. Already-read rows keep their original read_at: when the
 * operator saw it is more useful than when they last opened the page.
 */
export async function markRead(
  env: Env, operatorId: string, ids: string[],
): Promise<void> {
  const unique = [...new Set((ids ?? []).filter(Boolean))];
  if (unique.length === 0) return;

  const t = now();
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const chunk = unique.slice(i, i + ID_CHUNK);
    await env.DB.prepare(
      `UPDATE notifications SET read_at = ?
        WHERE operator_id = ? AND read_at IS NULL
          AND id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(t, operatorId, ...chunk).run();
  }
}

/** Clears the badge. One statement, still scoped to the one operator. */
export async function markAllRead(env: Env, operatorId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE notifications SET read_at = ?
      WHERE operator_id = ? AND read_at IS NULL`,
  ).bind(now(), operatorId).run();
}
