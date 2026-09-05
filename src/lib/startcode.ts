import type { Env } from '../types';
import { threadByToken } from './chat';
import { notify } from './feed';
import { flag } from './settlement';
import { badRequest, conflict, notFound, now } from './util';

/**
 * The start code, and the van.
 *
 * A four-digit code, shown only to the customer, read out to the operator,
 * typed in to start the job. It is not a security control -- four digits
 * against one live booking is not a threat model anybody needs to design
 * around -- it is EVIDENCE, and it is the only moment in the whole flow where
 * the platform knows rather than infers that these two people met.
 *
 * Which is what makes it worth more than every other signal here. An operator
 * who cancels after tapping "I'm here" has a story: I arrived, I didn't like
 * the look of it, I left. An operator who cancels after reading a code off the
 * customer's phone has stood next to them, been given the go-ahead, and then
 * declared the job never happened. There is no innocent version of that
 * sequence that also involves the work being done, and if the work WAS done,
 * it was done off the books.
 *
 * The van details are mostly not about fraud at all. Somebody is being asked
 * to open their front door to a stranger, and "a white Transit, plate ending
 * 4RTY" is the difference between opening it and not.
 */

/** Four digits. Long enough not to be guessed by somebody at the door. */
const CODE_LENGTH = 4;

/**
 * Wrong guesses before the code stops working.
 *
 * Five. Somebody with the job in front of them and the customer reading it out
 * gets this in one, or in two if they fat-finger it. A run of failures is
 * either the wrong booking open on their screen or somebody trying numbers,
 * and in both cases the right answer is to stop and make them talk to the
 * customer.
 */
const MAX_ATTEMPTS = 5;

/**
 * Generated with crypto, not Math.random.
 *
 * Not because four digits are worth protecting, but because Math.random in a
 * Worker is seeded per-isolate and can repeat across requests that land on the
 * same one. Two bookings on the same afternoon sharing a code is a support
 * ticket nobody would ever work out.
 */
export function newStartCode(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0]! % 10 ** CODE_LENGTH).padStart(CODE_LENGTH, '0');
}

export interface VehicleDetails {
  make: string | null;
  model: string | null;
  color: string | null;
  plate: string | null;
}

/** True when there is enough here for a customer to actually identify a van. */
export const vehicleComplete = (v: VehicleDetails | null): boolean =>
  !!v && !!v.make && !!v.color && !!v.plate;

export async function getVehicle(env: Env, operatorId: string): Promise<VehicleDetails> {
  const row = await env.DB.prepare(
    `SELECT vehicle_make, vehicle_model, vehicle_color, vehicle_plate
       FROM operators WHERE id = ?`,
  ).bind(operatorId).first<{
    vehicle_make: string | null; vehicle_model: string | null;
    vehicle_color: string | null; vehicle_plate: string | null;
  }>();
  return {
    make: row?.vehicle_make ?? null,
    model: row?.vehicle_model ?? null,
    color: row?.vehicle_color ?? null,
    plate: row?.vehicle_plate ?? null,
  };
}

export async function saveVehicle(
  env: Env, operatorId: string, v: Partial<VehicleDetails>,
): Promise<VehicleDetails> {
  const clean = (x: unknown, max = 40) =>
    typeof x === 'string' ? (x.trim().slice(0, max) || null) : null;

  await env.DB.prepare(
    `UPDATE operators SET vehicle_make=?, vehicle_model=?, vehicle_color=?,
       vehicle_plate=?, updated_at=? WHERE id=?`,
  ).bind(clean(v.make), clean(v.model), clean(v.color),
    // Kept exactly as typed. It is shown to a customer to check against their
    // own eyes and is never matched programmatically, so normalising it could
    // only make the stored version stop looking like the plate on the van.
    clean(v.plate, 16), now(), operatorId).run();

  return getVehicle(env, operatorId);
}

/** What the customer is shown before anybody turns up. */
export function describeVehicle(v: VehicleDetails): string | null {
  const parts = [v.color, v.make, v.model].filter(Boolean).join(' ');
  if (!parts && !v.plate) return null;
  if (!v.plate) return parts;
  return parts ? `${parts} · ${v.plate}` : v.plate;
}

// ---------------------------------------------------------------------------
// Using the code
// ---------------------------------------------------------------------------

/**
 * The operator types in what the customer read out.
 *
 * The comparison is deliberately not timing-safe and does not need to be: the
 * attacker would have to be standing at the address, the code dies with the
 * job, and five wrong guesses ends it. Reaching for constant-time comparison
 * here would be cargo-culting a defence against an attack nobody can mount.
 */
export async function verifyStartCode(
  env: Env, operatorId: string, orderItemId: string, typed: string,
): Promise<{ verified_at: number }> {
  const code = (typed ?? '').replace(/\D/g, '').slice(0, CODE_LENGTH);
  if (code.length !== CODE_LENGTH) {
    throw badRequest(`Ask them for their ${CODE_LENGTH}-digit code.`, 'bad_code');
  }

  const item = await env.DB.prepare(
    `SELECT id, start_code, code_verified_at, code_attempts, cancelled_at, starts_at
       FROM order_items WHERE id = ? AND operator_id = ?`,
  ).bind(orderItemId, operatorId).first<{
    id: string; start_code: string | null; code_verified_at: number | null;
    code_attempts: number; cancelled_at: number | null; starts_at: number;
  }>();
  if (!item) throw notFound('That booking is not yours.');
  if (item.cancelled_at) throw conflict('That booking was cancelled.', 'cancelled');
  if (item.code_verified_at) return { verified_at: item.code_verified_at };

  if (item.code_attempts >= MAX_ATTEMPTS) {
    throw conflict(
      'Too many wrong codes. Message the customer and we will sort it out.',
      'code_locked');
  }

  const t = now();

  if (!item.start_code || item.start_code !== code) {
    await env.DB.prepare(
      `UPDATE order_items SET code_attempts = code_attempts + 1 WHERE id = ?`,
    ).bind(orderItemId).run();
    const left = MAX_ATTEMPTS - (item.code_attempts + 1);
    throw badRequest(
      left > 0
        ? `That code does not match. ${left} ${left === 1 ? 'try' : 'tries'} left.`
        : 'That code does not match, and that was the last try. Message them instead.',
      'wrong_code');
  }

  const res = await env.DB.prepare(
    // arrived_at is set here too when the operator skipped the button. Typing
    // a code the customer just read out is a stronger arrival record than the
    // tap ever was, so there is no sense insisting on the weaker one first.
    //
    // cancelled_at is repeated here rather than only checked on the read above,
    // because the read is a separate round trip: a cancellation landing between
    // the two would otherwise stamp code_verified_at onto a cancelled booking.
    // That pairing is the strongest bypass signal the system has — see
    // 'confirmed_then_cancelled' in bypass.ts — and an ordering accident must
    // not be able to manufacture one against an operator.
    `UPDATE order_items
        SET code_verified_at = ?,
            arrived_at = COALESCE(arrived_at, ?),
            arrival_confirmed_at = COALESCE(arrival_confirmed_at, ?)
      WHERE id = ? AND code_verified_at IS NULL AND cancelled_at IS NULL`,
  ).bind(t, t, t, orderItemId).run();

  if ((res.meta.changes ?? 0) === 0) {
    const after = await env.DB.prepare(
      `SELECT code_verified_at FROM order_items WHERE id = ?`,
    ).bind(orderItemId).first<{ code_verified_at: number | null }>();
    if (after?.code_verified_at) return { verified_at: after.code_verified_at };
    throw conflict('That booking was cancelled.', 'cancelled');
  }

  return { verified_at: t };
}

/** The customer's copy of the code, and the van to look for. */
export async function jobCodeForGuest(env: Env, rawToken: string) {
  const thread = await threadByToken(env, rawToken);
  if (!thread?.appointment_id) return null;

  const item = await env.DB.prepare(
    `SELECT oi.id, oi.start_code, oi.code_verified_at, oi.starts_at, oi.cancelled_at
       FROM order_items oi
      WHERE oi.operator_id = ?
        AND oi.order_id = (SELECT order_id FROM order_items WHERE appointment_id = ? LIMIT 1)
        AND oi.cancelled_at IS NULL
      ORDER BY oi.starts_at LIMIT 1`,
  ).bind(thread.operator_id, thread.appointment_id).first<{
    id: string; start_code: string | null; code_verified_at: number | null;
    starts_at: number; cancelled_at: number | null;
  }>();
  if (!item) return null;

  const vehicle = await getVehicle(env, thread.operator_id);

  return {
    order_item_id: item.id,
    // Withheld once used. A code still on screen after the job started is a
    // number people write down and reuse, and it means nothing by then.
    code: item.code_verified_at ? null : item.start_code,
    verified_at: item.code_verified_at,
    starts_at: item.starts_at,
    vehicle,
    vehicle_label: describeVehicle(vehicle),
  };
}

/**
 * The customer says the van that turned up is not the one on the app.
 *
 * Not automatically anything. Vans break down and people borrow one, and the
 * honest version of this is common. What it does is put the booking in front
 * of a person, and give somebody who is uneasy on their own doorstep something
 * to do other than let a stranger they cannot identify into their house.
 */
export async function reportVehicle(
  env: Env, rawToken: string, orderItemId: string, note?: string | null,
): Promise<void> {
  const thread = await threadByToken(env, rawToken);
  if (!thread) throw notFound('That link is not valid any more.');

  const t = now();
  const res = await env.DB.prepare(
    `UPDATE order_items SET vehicle_reported_at = ?, vehicle_reported_note = ?
      WHERE id = ? AND operator_id = ?
        AND order_id = (SELECT order_id FROM order_items WHERE appointment_id = ? LIMIT 1)`,
  ).bind(t, (note ?? '').trim().slice(0, 500) || null,
    orderItemId, thread.operator_id, thread.appointment_id).run();

  if ((res.meta.changes ?? 0) === 0) throw notFound('That booking is not on your order.');

  await flag(env, thread.operator_id, orderItemId, 'location_dark',
    'The customer says the vehicle did not match the one on the account.');

  // The operator is told, and told neutrally. Somebody driving a hire van
  // because theirs is in the garage should hear this as "update your
  // details", not as an accusation.
  await notify(env, thread.operator_id, {
    kind: 'chat_message',
    title: 'A customer did not recognise your van',
    body: 'If you have changed vehicle, update it in your settings so people '
      + 'know what to look for.',
    thread_id: thread.id,
  });
}
