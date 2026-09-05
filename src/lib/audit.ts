import type { Env } from '../types';
import { newId, now, sha256 } from './util';

/**
 * A record of what the admin surface was used for.
 *
 * /api/admin/* is the one place in this product where a person reads other
 * people's data wholesale: the no-show queue carries every open dispute on the
 * site, by name and phone number, with whatever each side wrote about what
 * happened in somebody's home, and confirming one suspends or bans the
 * business it names. requireAdmin in ./auth decides who may. Nothing at all
 * recorded that anybody did — so a misused admin session left no trace, and
 * neither did a correct decision somebody later disagreed with.
 *
 * READS ARE LOGGED AS WELL AS WRITES, and that is the important half. The
 * queue is where the personal data actually is; opening it is the act most
 * likely to be misused and the one least likely to leave any other mark. A log
 * that only catches the ban is a log that catches the rarest thing an admin
 * does.
 *
 * THE LOG MUST NOT BECOME A SECOND COPY OF WHAT IT IS ABOUT. This is the
 * constraint the shape of the table is built around, and it is easy to get
 * wrong: the obvious audit row carries the customer's number and the note the
 * admin typed, and then the audit trail is a parallel database of exactly the
 * personal data an erasure is supposed to remove — outliving it, because
 * nothing thinks to erase the audit log.
 *
 * So a row holds who, what, when and WHICH RECORD, where "which record" is an
 * id this database already stores, or — when the subject is a customer, whose
 * only identifier is a phone number — a peppered hash of that number. The hash
 * can be checked against a number somebody already has, which is what an audit
 * trail is for, and it is not a phone number, which is what it must not be.
 */

export type AdminAction =
  | 'read_no_show_queue'
  | 'confirm_no_show'
  | 'reject_no_show'
  | 'read_flags';

export interface AuditEntry {
  action: AdminAction;
  subject_kind?: 'operator' | 'customer' | 'report' | 'queue';
  /**
   * An id we already hold. For a customer, pass the phone number as
   * `subject_phone` instead and it is hashed here — a raw number must never
   * reach this column.
   */
  subject_ref?: string | null;
  subject_phone?: string | null;
  /** Short and structural: 'confirmed', 'strike_2', 'rows_12'. Never prose. */
  detail?: string | null;
}

/**
 * Writes one line, and never fails the request it is describing.
 *
 * An audit write that can throw is an audit write that will one day take down
 * the moderation queue over a full disk, and the pressure at that moment will
 * be to remove the logging rather than fix the disk. The failure is logged to
 * the console, which is the one place left to say it.
 */
export async function recordAdminAction(
  env: Env, actorOperatorId: string, entry: AuditEntry,
): Promise<void> {
  try {
    const ref = entry.subject_phone
      ? await sha256(`${entry.subject_phone}:${env.SESSION_PEPPER}`)
      : (entry.subject_ref ?? null);

    await env.DB.prepare(
      `INSERT INTO admin_actions
         (id, actor_operator_id, action, subject_kind, subject_ref, detail, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(newId(), actorOperatorId, entry.action, entry.subject_kind ?? null,
      ref, entry.detail ?? null, now()).run();
  } catch (e) {
    console.error('admin audit write failed', entry.action, e);
  }
}

/**
 * The log, most recent first, for an admin reviewing what has been done.
 *
 * Reading it is itself an admin action and the route logs it like any other.
 */
export async function listAdminActions(env: Env, limit = 100) {
  const rows = await env.DB.prepare(
    `SELECT id, actor_operator_id, action, subject_kind, subject_ref, detail, created_at
       FROM admin_actions ORDER BY created_at DESC LIMIT ?`,
  ).bind(Math.min(Math.max(1, Math.floor(limit)), 500)).all();
  return rows.results ?? [];
}
