import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import {
  listNotifications, markAllRead, markRead, notify, unreadCount,
} from '../src/lib/feed';
import { now } from '../src/lib/util';

const MIGRATIONS = ALL_MIGRATIONS;

let env: Env;
const OP = 'op1';
const OTHER = 'op2';

/** Two operators, so every test can prove one cannot reach the other's rows. */
async function seed() {
  env = makeEnv(MIGRATIONS) as unknown as Env;
  const n = now();
  for (const [id, email, name] of [
    [OP, 'a@x.com', 'Valley Detailing'],
    [OTHER, 'b@x.com', 'Canyon Mobile Wash'],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO operators (id,email,business_name,timezone,country,currency,language,
         location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
         offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
         discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at)
       VALUES (?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
         900,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?)`,
    ).bind(id, email, name, n, n).run();
  }
}

const countRows = async (operatorId: string) => {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notifications WHERE operator_id = ?`,
  ).bind(operatorId).first<{ n: number }>();
  return row?.n ?? 0;
};

beforeEach(seed);

describe('the operator finds out', () => {
  it('records a booking and lists it', async () => {
    const start = now() + 4 * 3600;
    await notify(env, OP, {
      kind: 'public_booking',
      title: 'Rosa booked Thursday',
      body: 'Full detail · 15200 Ventura Blvd',
      appointment_id: 'appt1',
      claim_id: 'claim1',
      starts_at: start,
    });

    const feed = await listNotifications(env, OP);
    expect(feed).toHaveLength(1);
    expect(feed[0]!.kind).toBe('public_booking');
    expect(feed[0]!.title).toBe('Rosa booked Thursday');
    expect(feed[0]!.body).toBe('Full detail · 15200 Ventura Blvd');
    expect(feed[0]!.appointment_id).toBe('appt1');
    expect(feed[0]!.claim_id).toBe('claim1');
    expect(feed[0]!.starts_at).toBe(start);
    expect(feed[0]!.read_at).toBeNull();
  });

  it('puts the newest first, because that is the one that changes today', async () => {
    for (const title of ['first', 'second', 'third']) {
      await notify(env, OP, { kind: 'public_booking', title });
    }
    // Three notifications written in the same test land in the same second.
    // Real ones do not, so the clock is spread out here rather than leaving the
    // assertion to depend on how ties happen to fall.
    const n = now();
    const ages: Record<string, number> = { first: n - 300, second: n - 200, third: n - 100 };
    for (const [title, at] of Object.entries(ages)) {
      await env.DB.prepare(
        `UPDATE notifications SET created_at = ? WHERE operator_id = ? AND title = ?`,
      ).bind(at, OP, title).run();
    }

    expect((await listNotifications(env, OP)).map((r) => r.title))
      .toEqual(['third', 'second', 'first']);
  });

  it('shows one operator nothing of another\'s', async () => {
    await notify(env, OP, { kind: 'public_booking', title: 'mine' });
    await notify(env, OTHER, { kind: 'public_booking', title: 'theirs' });

    expect((await listNotifications(env, OP)).map((r) => r.title)).toEqual(['mine']);
    expect((await listNotifications(env, OTHER)).map((r) => r.title)).toEqual(['theirs']);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await notify(env, OP, { kind: 'public_booking', title: `n${i}` });
    }
    expect(await listNotifications(env, OP, { limit: 2 })).toHaveLength(2);
  });
});

describe('read and unread', () => {
  it('counts only what has not been read', async () => {
    await notify(env, OP, { kind: 'public_booking', title: 'one' });
    await notify(env, OP, { kind: 'public_booking', title: 'two' });
    expect(await unreadCount(env, OP)).toBe(2);

    const feed = await listNotifications(env, OP);
    await markRead(env, OP, [feed[0]!.id]);

    expect(await unreadCount(env, OP)).toBe(1);
    expect(await listNotifications(env, OP, { unreadOnly: true })).toHaveLength(1);
    // The read one is still in the feed. Read is not deleted.
    expect(await listNotifications(env, OP)).toHaveLength(2);
  });

  it('counts unread per operator, not across the table', async () => {
    await notify(env, OP, { kind: 'public_booking', title: 'mine' });
    await notify(env, OTHER, { kind: 'public_booking', title: 'theirs' });
    expect(await unreadCount(env, OP)).toBe(1);
    expect(await unreadCount(env, OTHER)).toBe(1);
  });

  it('cannot mark another operator\'s notification read', async () => {
    await notify(env, OTHER, { kind: 'public_booking', title: 'theirs' });
    const theirs = (await listNotifications(env, OTHER))[0]!;

    // OP knows the id and asks for it anyway. operator_id is in the WHERE
    // clause, so this touches nothing at all.
    await markRead(env, OP, [theirs.id]);

    expect(await unreadCount(env, OTHER)).toBe(1);
    expect((await listNotifications(env, OTHER))[0]!.read_at).toBeNull();
  });

  it('marks everything read for one operator and leaves the other alone', async () => {
    await notify(env, OP, { kind: 'public_booking', title: 'one' });
    await notify(env, OP, { kind: 'offer_accepted', title: 'two' });
    await notify(env, OTHER, { kind: 'public_booking', title: 'theirs' });

    await markAllRead(env, OP);

    expect(await unreadCount(env, OP)).toBe(0);
    expect(await listNotifications(env, OP, { unreadOnly: true })).toHaveLength(0);
    expect(await listNotifications(env, OP)).toHaveLength(2);
    for (const r of await listNotifications(env, OP)) expect(r.read_at).not.toBeNull();

    // The other operator's badge is untouched.
    expect(await unreadCount(env, OTHER)).toBe(1);
  });

  it('does nothing when given no ids', async () => {
    await notify(env, OP, { kind: 'public_booking', title: 'one' });
    await markRead(env, OP, []);
    expect(await unreadCount(env, OP)).toBe(1);
  });
});

describe('a failed notification never costs a booking', () => {
  it('swallows a write the database refuses', async () => {
    // 'invented' is not in the CHECK constraint, so the INSERT is rejected.
    // In production the caller is claimSlot, mid-booking: if this threw, the
    // stranger would be told their booking failed because a message could not
    // be filed.
    await expect(notify(env, OP, {
      kind: 'invented' as never, title: 'should not be written',
    })).resolves.toBeUndefined();

    expect(await countRows(OP)).toBe(0);
    expect(await unreadCount(env, OP)).toBe(0);
    expect(await listNotifications(env, OP)).toHaveLength(0);
  });

  it('swallows a write for an operator that does not exist', async () => {
    // The foreign key refuses this one. Same rule: no throw, no row.
    await expect(notify(env, 'no-such-operator', {
      kind: 'public_booking', title: 'orphan',
    })).resolves.toBeUndefined();

    const all = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM notifications`).first<{ n: number }>();
    expect(all!.n).toBe(0);
  });

  it('keeps working after a failure', async () => {
    await notify(env, OP, { kind: 'bogus' as never, title: 'no' });
    await notify(env, OP, { kind: 'public_booking', title: 'yes' });
    expect((await listNotifications(env, OP)).map((r) => r.title)).toEqual(['yes']);
  });
});
