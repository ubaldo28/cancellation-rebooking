import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { firstNameOnly, maskCustomerRow, redactContact } from '../src/lib/redact';
import { startThread } from '../src/lib/chat';
import { sendQuote } from '../src/lib/parts';
import { leaveReview, replyToReview } from '../src/lib/reviews';
import { notify } from '../src/lib/feed';
import { placeOrder } from '../src/lib/orders';
import { eraseCustomerByToken } from '../src/lib/retention';
import { newId, now, sha256 } from '../src/lib/util';

/**
 * Who can see whose details, and what a person is allowed to type at somebody.
 *
 * The rule the whole product is built on is that the two sides talk here or
 * not at all: the customer never gets the operator's mobile, the operator
 * never gets the customer's, and neither can hand one over in a free text box.
 * These tests cover the places that rule was stated but not actually enforced.
 */

const BASE = 'https://gap.test';
let env: Env;
let objects: Map<string, Uint8Array>;

function fakeBucket() {
  objects = new Map();
  return {
    put: async (key: string) => { objects.set(key, new Uint8Array()); return {}; },
    get: async (key: string) => (objects.has(key)
      ? { body: new Blob([new Uint8Array()]).stream() } : null),
    delete: async (key: string) => { objects.delete(key); },
  };
}

function makeReq(method: string, path: string, opts: {
  body?: unknown; cookie?: string; ip?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers['cookie'] = opts.cookie;
  headers['cf-connecting-ip'] = opts.ip ?? '203.0.113.55';
  return new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const call = (method: string, path: string, opts?: Parameters<typeof makeReq>[2]) =>
  worker.fetch(makeReq(method, path, opts), env, {} as ExecutionContext);

const one = <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql).bind(...args).first<T>();

async function signIn(email: string, opId = newId()) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,
       location_mode,fill_model,sms_mode,plan,accept_public_bookings,created_at,updated_at)
     VALUES (?,?, 'A Business','America/Los_Angeles','US','USD','mobile','both','device',
       'active',1,?,?)`,
  ).bind(opId, email, t, t).run();

  const raw = `sess-${opId}`;
  const hash = await sha256(`${raw}:${env.SESSION_PEPPER}`);
  await env.DB.prepare(
    `INSERT INTO sessions (id,operator_id,token_hash,expires_at,created_at)
     VALUES (?,?,?,?,?)`,
  ).bind(newId(), opId, hash, t + 86400, t).run();
  return { opId, cookie: `gf_session=${raw}` };
}

beforeEach(() => {
  env = { ...makeEnv(ALL_MIGRATIONS), PHOTOS: fakeBucket() } as unknown as Env;
});

// ---------------------------------------------------------------------------
describe('an operator never gets a platform customer\'s number, on any route', () => {
  async function client(opId: string, id: string, acquired: string, phone: string) {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,last_name,phone_e164,email,
         acquired,created_at,updated_at)
       VALUES (?,?, 'Rosa','Delgado',?, 'rosa@example.com',?,?,?)`,
    ).bind(id, opId, phone, acquired, t, t).run();
  }

  it('masks them on the lead list, which joined the same table by another route', async () => {
    const op = await signIn('op@example.com');
    await client(op.opId, 'c-public', 'public', '+13105550147');
    const t = now();
    await env.DB.prepare(
      `INSERT INTO job_leads (id,operator_id,client_id,title,status,created_at,updated_at)
       VALUES (?,?, 'c-public','Replace mixer tap','open',?,?)`,
    ).bind(newId(), op.opId, t, t).run();

    const body = await (await call('GET', '/api/leads', { cookie: op.cookie })).text();
    expect(body).not.toContain('3105550147');
    expect(body).not.toContain('rosa@example.com');
    // The masked form is still enough to tell two bookings apart on a busy day.
    expect(body).toContain('47');
  });

  it('leaves an operator\'s own imported client alone on the same route', async () => {
    const op = await signIn('op@example.com');
    await client(op.opId, 'c-mine', 'operator', '+13105550111');
    const t = now();
    await env.DB.prepare(
      `INSERT INTO job_leads (id,operator_id,client_id,title,status,created_at,updated_at)
       VALUES (?,?, 'c-mine','Service the boiler','open',?,?)`,
    ).bind(newId(), op.opId, t, t).run();

    const body = await (await call('GET', '/api/leads', { cookie: op.cookie })).text();
    // They typed this number in themselves. Masking it would be the product
    // hiding an operator's own address book from them.
    expect(body).toContain('+13105550111');
  });

  it('masks them on the client list too', async () => {
    const op = await signIn('op@example.com');
    await client(op.opId, 'c-public', 'public', '+13105550147');
    const body = await (await call('GET', '/api/clients', { cookie: op.cookie })).text();
    expect(body).not.toContain('3105550147');
  });
});

// ---------------------------------------------------------------------------
describe('the fields a stranger types that are not called "message"', () => {
  it('strips a number out of the name at the top of the conversation', async () => {
    const op = await signIn('op@example.com');
    const { thread } = await startThread(env, {
      operator_id: op.opId,
      guest_name: 'Rosa 818 555 0199',
      subject: 'call me on 8185550199',
      first_message: 'hello',
    });
    expect(thread.guest_name).not.toContain('5550199');
    expect(thread.subject ?? '').not.toContain('5550199');

    const row = await one<{ guest_name: string; subject: string | null }>(
      `SELECT guest_name, subject FROM threads WHERE id = ?`, thread.id);
    // Cleaned before the insert, so the number never lands in the row for a
    // backup or an export to carry.
    expect(row?.guest_name).not.toContain('5550199');
    expect(row?.subject ?? '').not.toContain('5550199');
  });

  it('strips one out of the operator\'s parts quote', async () => {
    const op = await signIn('op@example.com');
    const t = now();
    await env.DB.prepare(
      `INSERT INTO orders (id,status,guest_name,phone_e164,currency,total_cents,
         created_at,updated_at)
       VALUES ('o-1','confirmed','Rosa','+13105550147','USD',12500,?,?)`,
    ).bind(t, t).run();
    await env.DB.prepare(
      `INSERT INTO order_items (id,order_id,operator_id,appointment_id,starts_at,ends_at,
         duration_seconds,price_cents,created_at)
       VALUES ('i-1','o-1',?, 'a-1',?,?,3600,12500,?)`,
    ).bind(op.opId, t + 3600, t + 7200, t).run();

    const quote = await sendQuote(env, op.opId, {
      order_item_id: 'i-1',
      description: 'Alternator $340 - call me on 818 555 0199 and I will do it cash',
      parts_cents: 34000, labor_cents: 0,
    } as never);

    // The one free-text box in the product that goes from a business to a
    // stranger with nothing reading it.
    expect(quote.description).not.toContain('5550199');
  });

  it('strips one out of a public review and out of the reply under it', async () => {
    const op = await signIn('op@example.com');
    const t = now();
    await env.DB.prepare(
      `INSERT INTO orders (id,status,guest_name,phone_e164,currency,total_cents,
         created_at,updated_at)
       VALUES ('o-2','confirmed','Rosa','+13105550147','USD',12500,?,?)`,
    ).bind(t, t).run();
    await env.DB.prepare(
      `INSERT INTO order_items (id,order_id,operator_id,appointment_id,starts_at,ends_at,
         duration_seconds,price_cents,created_at,work_confirmed)
       VALUES ('i-2','o-2',?, 'a-2',?,?,3600,12500,?, 'done')`,
    ).bind(op.opId, t - 7200, t - 3600, t).run();
    await env.DB.prepare(
      `INSERT INTO threads (id,operator_id,appointment_id,guest_name,guest_token_hash,
         last_message_at,status,created_at,updated_at)
       VALUES ('th-2',?, 'a-2','Rosa',?,?, 'open',?,?)`,
    ).bind(op.opId, await sha256(`rv-token:${env.SESSION_PEPPER}`), t, t, t).run();

    const review = await leaveReview(env, 'rv-token', {
      order_item_id: 'i-2', rating: 5, body: 'Great job, reach me on 818 555 0199 next time',
    });
    // A number in a chat message reaches one person. The same number on a
    // profile page reaches everybody.
    expect(review.body ?? '').not.toContain('5550199');

    await replyToReview(env, op.opId, review.id, 'Thanks! Call me direct on 8185550199');
    const row = await one<{ reply: string }>(`SELECT reply FROM reviews WHERE id = ?`, review.id);
    expect(row?.reply).not.toContain('5550199');
  });
});

// ---------------------------------------------------------------------------
describe('the evasions the filter used to walk straight past', () => {
  const gone = (s: string) => redactContact(s).body;

  it('catches a number spelled out in words', () => {
    expect(gone('eight one eight five five five oh one nine nine'))
      .not.toMatch(/eight one eight/);
  });

  it('catches letters standing in for digits', () => {
    expect(gone('8I8 555 O199')).not.toContain('555');
  });

  it('catches digits typed on another keyboard', () => {
    expect(gone('ping me on ٨١٨٥٥٥٠١٩٩')).toContain('[removed]');
  });

  it('catches an address with the punctuation spelled out', () => {
    expect(gone('rosa at gmail dot com')).not.toContain('gmail');
  });

  it('still leaves the sentences people actually write', () => {
    // A filter that eats prices, dates and gate codes is a filter somebody
    // demands be switched off, which is worse than the number it was catching.
    for (const ordinary of [
      'the gate code is 4471',
      'that will be $1,250.00 all in',
      'total was 1500.00 for 3 rooms',
      'I can do 3/14/2026 around 9am',
      'my address is 15200 Ventura Blvd, 91403',
      'Two coats, one bedroom and the hallway',
      // The "at ... dot ..." pattern must not eat the end of a sentence.
      'I will be at yours. Thanks for booking',
      'Park at 9. See you then',
      'Suite 100, Los Angeles',
    ]) {
      expect(gone(ordinary), ordinary).toBe(ordinary);
    }
  });
});

// ---------------------------------------------------------------------------
describe('photographs taken inside somebody\'s house', () => {
  async function photo(opId: string, id: string, released: number) {
    const t = now();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO orders (id,status,guest_name,phone_e164,currency,total_cents,
         created_at,updated_at)
       VALUES ('o-p','confirmed','Rosa','+13105550147','USD',12500,?,?)`,
    ).bind(t, t).run();
    await env.DB.prepare(
      `INSERT INTO order_items (id,order_id,operator_id,starts_at,ends_at,duration_seconds,
         price_cents,created_at)
       VALUES (?, 'o-p',?,?,?,3600,12500,?)`,
    ).bind(`item-${id}`, opId, t - 7200, t - 3600, t).run();
    await env.DB.prepare(
      `INSERT INTO job_photos (id,order_item_id,operator_id,uploaded_by,stage,r2_key,
         content_type,bytes,created_at,public_on_review)
       VALUES (?,?,?, 'customer','after',?, 'image/jpeg',1024,?,?)`,
    ).bind(id, `item-${id}`, opId, `j/${opId}/${id}`, t, released).run();
    objects.set(`j/${opId}/${id}`, new Uint8Array());
  }

  it('serves the one the customer published on their own review', async () => {
    const op = await signIn('op@example.com');
    await photo(op.opId, 'ph-public', 1);
    expect((await call('GET', '/api/public/review-photo/ph-public')).status).toBe(200);
  });

  it('refuses every other photo on the same public route', async () => {
    const op = await signIn('op@example.com');
    await photo(op.opId, 'ph-private', 0);
    // The default is private, and the only thing that makes one public is the
    // customer deliberately releasing it onto their own review.
    expect((await call('GET', '/api/public/review-photo/ph-private')).status).toBe(404);
  });

  it('refuses a rival business asking for it by id', async () => {
    const mine = await signIn('mine@example.com');
    const rival = await signIn('rival@example.com');
    await photo(mine.opId, 'ph-mine', 0);
    expect((await call('GET', '/api/proof/ph-mine', { cookie: rival.cookie })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('the admin surface leaves a record of itself', () => {
  async function openReport(againstOpId: string) {
    const t = now();
    const id = newId();
    await env.DB.prepare(
      `INSERT INTO orders (id,status,guest_name,phone_e164,currency,total_cents,
         created_at,updated_at)
       VALUES ('o-a','confirmed','Rosa','+13105550147','USD',12500,?,?)`,
    ).bind(t, t).run();
    await env.DB.prepare(
      `INSERT INTO order_items (id,order_id,operator_id,starts_at,ends_at,duration_seconds,
         price_cents,created_at)
       VALUES ('i-a','o-a',?,?,?,3600,12500,?)`,
    ).bind(againstOpId, t - 7200, t - 3600, t).run();
    await env.DB.prepare(
      `INSERT INTO no_show_reports (id,order_item_id,against,operator_id,phone_e164,
         note,status,created_at,updated_at)
       VALUES (?, 'i-a','operator',?, '+13105550147','never showed','open',?,?)`,
    ).bind(id, againstOpId, t, t).run();
    return id;
  }

  it('records a read of the queue, not only a decision on it', async () => {
    const victim = await signIn('victim@example.com');
    await openReport(victim.opId);
    const admin = await signIn('ops@slotfill.app');
    env.ADMIN_EMAILS = 'ops@slotfill.app';

    expect((await call('GET', '/api/admin/no-shows', { cookie: admin.cookie })).status).toBe(200);

    const row = await one<{ action: string; actor_operator_id: string; detail: string }>(
      `SELECT action, actor_operator_id, detail FROM admin_actions`);
    // Opening the queue is the act most likely to be misused and the one least
    // likely to leave any other trace.
    expect(row?.action).toBe('read_no_show_queue');
    expect(row?.actor_operator_id).toBe(admin.opId);
    expect(row?.detail).toBe('rows_1');
  });

  it('does not hand the admin the customer\'s number to decide a no-show with', async () => {
    const victim = await signIn('victim@example.com');
    await openReport(victim.opId);
    const admin = await signIn('ops@slotfill.app');
    env.ADMIN_EMAILS = 'ops@slotfill.app';

    const res = await call('GET', '/api/admin/no-shows', { cookie: admin.cookie });
    const body = await res.text();
    // The decision turns on the timeline and on whether this has happened
    // before. The number was standing in for the second of those, so the
    // strike count answers it directly and the number stays where it is.
    expect(body).not.toContain('3105550147');
    expect(body).toContain('customer_strikes');
  });

  it('records a decision, and does not copy the dispute into the log', async () => {
    const victim = await signIn('victim@example.com');
    const reportId = await openReport(victim.opId);
    const admin = await signIn('ops@slotfill.app');
    env.ADMIN_EMAILS = 'ops@slotfill.app';

    await call('POST', `/api/admin/no-shows/${reportId}`, {
      cookie: admin.cookie, body: { decision: 'confirmed', note: 'Rosa on 310 555 0147 confirmed' },
    });

    const rows = await env.DB.prepare(
      `SELECT action, subject_ref, detail FROM admin_actions WHERE action = 'confirm_no_show'`,
    ).all<{ action: string; subject_ref: string; detail: string }>();
    expect(rows.results?.length).toBe(1);
    expect(rows.results?.[0]?.subject_ref).toBe(reportId);

    // An audit trail that quietly duplicated the personal data of every
    // dispute would be a bigger liability than the gap it filled -- and it
    // would outlive the erasure that removes the original.
    const all = JSON.stringify(rows.results);
    expect(all).not.toContain('3105550147');
    expect(all).not.toContain('Rosa');
  });

  it('writes nothing when somebody who is not an admin asks', async () => {
    const victim = await signIn('victim@example.com');
    await openReport(victim.opId);
    const nosey = await signIn('nosey@example.com');

    expect((await call('GET', '/api/admin/no-shows', { cookie: nosey.cookie })).status).toBe(404);
    const row = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM admin_actions`);
    expect(row?.n).toBe(0);
  });

  it('hashes a customer subject rather than storing the number', async () => {
    const admin = await signIn('ops@slotfill.app');
    env.ADMIN_EMAILS = 'ops@slotfill.app';
    const { recordAdminAction } = await import('../src/lib/audit');
    await recordAdminAction(env, admin.opId, {
      action: 'confirm_no_show', subject_kind: 'customer', subject_phone: '+13105550147',
    });
    const row = await one<{ subject_ref: string }>(
      `SELECT subject_ref FROM admin_actions`);
    expect(row?.subject_ref).toBe(await sha256(`+13105550147:${env.SESSION_PEPPER}`));
  });
});

// ---------------------------------------------------------------------------
describe('the doorstep, released to the operator and taken back again', () => {
  /**
   * Migration 0022 released the street address at the moment a booking exists
   * and cleared `order_items.address_released_at` when it is cancelled, saying
   * in as many words that the column exists so that "can they see it" is not
   * re-derived from booking status in four different queries. Nothing read it.
   * Cancelling therefore cleared the column and the schedule went on printing
   * the address off the appointment row, so somebody who booked and cancelled
   * had handed a stranger their address until the retention sweep caught up
   * with it months later.
   */
  const ADDRESS = '18 Camrose Avenue';

  async function booking(opId: string, released: number | null) {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,acquired,platform_introduced,
         is_active,created_at,updated_at)
       VALUES ('c-rel',?,'Rosa','public',1,1,?,?)`,
    ).bind(opId, t, t).run();
    await env.DB.prepare(
      `INSERT INTO appointments (id,operator_id,client_id,starts_at,ends_at,is_mobile,
         address_line,postcode,lat,lng,status,source,created_at,updated_at)
       VALUES ('a-rel',?,'c-rel',?,?,1,?, '91403', 34.16, -118.44,
         'scheduled','online',?,?)`,
    ).bind(opId, t + 3600, t + 7200, ADDRESS, t, t).run();
    await env.DB.prepare(
      `INSERT INTO orders (id,status,guest_name,currency,total_cents,created_at,updated_at)
       VALUES ('o-rel','confirmed','Rosa','USD',6500,?,?)`,
    ).bind(t, t).run();
    await env.DB.prepare(
      `INSERT INTO order_items (id,order_id,operator_id,appointment_id,starts_at,ends_at,
         duration_seconds,price_cents,address_released_at,created_at)
       VALUES ('i-rel','o-rel',?, 'a-rel',?,?,3600,6500,?,?)`,
    ).bind(opId, t + 3600, t + 7200, released, t).run();
  }

  const appointments = async (cookie: string) => {
    const res = await call('GET', '/api/appointments', { cookie });
    expect(res.status).toBe(200);
    return (await res.json() as any).appointments as any[];
  };

  it('gives the operator the address while the booking is live', async () => {
    const op = await signIn('live@example.com');
    await booking(op.opId, now());
    const [a] = await appointments(op.cookie);
    // They have to drive there, so this half is the product working.
    expect(a.address_line).toBe(ADDRESS);
    expect(a.lat).toBeCloseTo(34.16, 5);
  });

  it('stops giving it out the moment the release is withdrawn', async () => {
    const op = await signIn('gone@example.com');
    await booking(op.opId, null);
    const [a] = await appointments(op.cookie);
    expect(a.address_line).toBeNull();
    // The coordinates go with the street line. Five decimal places of latitude
    // is the address written differently, so leaving them would be releasing
    // it under another name.
    expect(a.lat).toBeNull();
    expect(a.lng).toBeNull();
    // Everything the operator still legitimately needs survives.
    expect(a.id).toBe('a-rel');
    expect(a.starts_at).toBeGreaterThan(0);
    expect(a.first_name).toBe('Rosa');
    expect(a.postcode).toBe('91403');
  });

  it('leaves an operator\'s own booking alone, which has no release to withdraw',
    async () => {
      const op = await signIn('own@example.com');
      const t = now();
      await env.DB.prepare(
        `INSERT INTO clients (id,operator_id,first_name,phone_e164,acquired,is_active,
           created_at,updated_at)
         VALUES ('c-own',?,'Marta','+13105550188','operator',1,?,?)`,
      ).bind(op.opId, t, t).run();
      await env.DB.prepare(
        `INSERT INTO appointments (id,operator_id,client_id,starts_at,ends_at,is_mobile,
           address_line,lat,lng,status,source,created_at,updated_at)
         VALUES ('a-own',?,'c-own',?,?,1,'4 Otter Lane',34.2,-118.5,
           'scheduled','manual',?,?)`,
      ).bind(op.opId, t + 3600, t + 7200, t, t).run();

      const [a] = await appointments(op.cookie);
      // No order item, so no release model: this is a customer out of their own
      // book whose address they typed in themselves.
      expect(a.address_line).toBe('4 Otter Lane');
      expect(a.lat).toBe(34.2);
    });
});

// ---------------------------------------------------------------------------
describe('a customer saying the van was not the one on the app', () => {
  /**
   * The report was written to two columns nothing read, and filed as a
   * 'location_dark' bypass flag — which means "no recent position fix at the
   * moment they cancelled on arrival". So the customer's own words went
   * nowhere, and a hire van counted against the operator's flag rate.
   */
  async function jobWithGuestLink(opId: string) {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO appointments (id,operator_id,starts_at,ends_at,is_mobile,status,
         source,created_at,updated_at)
       VALUES ('a-van',?,?,?,1,'scheduled','online',?,?)`,
    ).bind(opId, t + 3600, t + 7200, t, t).run();
    await env.DB.prepare(
      `INSERT INTO orders (id,status,guest_name,currency,total_cents,created_at,updated_at)
       VALUES ('o-van','confirmed','Rosa','USD',6500,?,?)`,
    ).bind(t, t).run();
    await env.DB.prepare(
      `INSERT INTO order_items (id,order_id,operator_id,appointment_id,starts_at,ends_at,
         duration_seconds,price_cents,address_released_at,created_at)
       VALUES ('i-van','o-van',?, 'a-van',?,?,3600,6500,?,?)`,
    ).bind(opId, t + 3600, t + 7200, t, t).run();

    const raw = `guest-${opId}`;
    await env.DB.prepare(
      `INSERT INTO threads (id,operator_id,appointment_id,guest_name,guest_token_hash,
         status,last_message_at,created_at,updated_at)
       VALUES ('t-van',?, 'a-van','Rosa',?, 'open',?,?,?)`,
    ).bind(opId, await sha256(`${raw}:${env.SESSION_PEPPER}`), t, t, t).run();
    return raw;
  }

  it('records what they wrote and puts it in front of an admin', async () => {
    const op = await signIn('van@example.com');
    await env.DB.prepare(
      `UPDATE operators SET business_name='Hard Rain', vehicle_make='Ford',
         vehicle_model='Transit', vehicle_color='white', vehicle_plate='8ABC123'
        WHERE id=?`,
    ).bind(op.opId).run();
    const token = await jobWithGuestLink(op.opId);

    const res = await call('POST', `/api/public/threads/${token}/vehicle/i-van`,
      { body: { note: 'It was a red hire van with no signwriting.' } });
    expect(res.status).toBe(200);

    const admin = await signIn('ops@slotfill.app');
    env.ADMIN_EMAILS = 'ops@slotfill.app';
    const queue = await (await call('GET', '/api/admin/flags',
      { cookie: admin.cookie })).json() as any;

    expect(queue.vehicle_reports).toHaveLength(1);
    const report = queue.vehicle_reports[0];
    // The customer's own words, as typed. A summary of them is not evidence.
    expect(report.note).toBe('It was a red hire van with no signwriting.');
    expect(report.order_item_id).toBe('i-van');
    expect(report.business_name).toBe('Hard Rain');
    // The van as the account describes it now, which is the comparison the
    // person reading this has to make.
    expect(report.vehicle_label).toBe('white Ford Transit · 8ABC123');
    expect(report.reported_at).toBeGreaterThan(0);
  });

  it('does not count as a bypass flag against the business', async () => {
    const op = await signIn('van2@example.com');
    const token = await jobWithGuestLink(op.opId);
    await call('POST', `/api/public/threads/${token}/vehicle/i-van`,
      { body: { note: 'Different van.' } });

    // A hire van is the ordinary explanation. Counting it would put it into
    // the rate flagSummary compares against peers, and — because bypass_flags
    // is unique on (order_item_id, kind) — would swallow a real location_dark
    // on the same booking afterwards.
    const flags = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM bypass_flags`);
    expect(flags?.n).toBe(0);

    const summary = await (await call('GET', '/api/flags',
      { cookie: op.cookie })).json() as any;
    expect(summary.summary.flags).toBe(0);
  });

  it('tells the operator, without repeating the accusation at them', async () => {
    const op = await signIn('van3@example.com');
    const token = await jobWithGuestLink(op.opId);
    await call('POST', `/api/public/threads/${token}/vehicle/i-van`,
      { body: { note: 'The driver would not say who he was.' } });

    const note = await one<{ title: string; body: string }>(
      `SELECT title, body FROM notifications WHERE operator_id = ?`, op.opId);
    expect(note?.title).toContain('did not recognise your van');
    // Somebody driving a hire van because theirs is in the garage should read
    // this as "update your details", not as a report of what a customer said
    // about them.
    expect(note?.body).not.toContain('would not say who he was');
  });

  it('refuses a booking that is not on the caller\'s own order', async () => {
    const mine = await signIn('van4@example.com');
    const theirs = await signIn('van5@example.com');
    const token = await jobWithGuestLink(mine.opId);
    const t = now();
    await env.DB.prepare(
      `INSERT INTO orders (id,status,guest_name,currency,total_cents,created_at,updated_at)
       VALUES ('o-other','confirmed','Sam','USD',6500,?,?)`,
    ).bind(t, t).run();
    await env.DB.prepare(
      `INSERT INTO order_items (id,order_id,operator_id,starts_at,ends_at,duration_seconds,
         price_cents,created_at)
       VALUES ('i-other','o-other',?,?,?,3600,6500,?)`,
    ).bind(theirs.opId, t + 3600, t + 7200, t).run();

    const res = await call('POST', `/api/public/threads/${token}/vehicle/i-other`,
      { body: { note: 'nothing to do with me' } });
    expect(res.status).toBe(404);
    const row = await one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM order_items WHERE vehicle_reported_at IS NOT NULL`);
    expect(row?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the withdrawn doorstep, on every list that shows one', () => {
  /**
   * maskWithdrawnAddress was written, was correct, and was called once. The
   * schedule stopped showing a cancelled booking's address; the client list
   * and the leads list went on serving the street line and the coordinates,
   * because those two queries joined the same clients table by a different
   * route and nobody updated them. That is the identical failure the comment
   * on maskClientRow describes — one query out of four — and a second helper
   * that also has to be remembered would only have moved it.
   *
   * So the fix these test is maskCustomerRow: one call, one argument,
   * everything read off the row, and an address withheld when the query did
   * not ask whether the release still stands.
   */
  const ADDRESS = '18 Camrose Avenue';

  /** A platform booking, its client, and the order item that released it. */
  async function booked(opId: string, released: number | null) {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO clients (id,operator_id,first_name,last_name,phone_e164,email,
         address_line,postcode,lat,lng,acquired,platform_introduced,is_active,
         created_at,updated_at)
       VALUES ('c-w',?,'Rosa','Delacroix','+13105550142','rosa@example.com',?,
         '91403',34.151,-118.445,'public',1,1,?,?)`,
    ).bind(opId, ADDRESS, t, t).run();
    await env.DB.prepare(
      `INSERT INTO appointments (id,operator_id,client_id,starts_at,ends_at,is_mobile,
         address_line,postcode,lat,lng,status,source,created_at,updated_at)
       VALUES ('a-w',?,'c-w',?,?,1,?, '91403',34.151,-118.445,'scheduled','online',?,?)`,
    ).bind(opId, t + 3600, t + 7200, ADDRESS, t, t).run();
    await env.DB.prepare(
      `INSERT INTO orders (id,status,guest_name,currency,total_cents,created_at,updated_at)
       VALUES ('o-w','confirmed','Rosa','USD',6500,?,?)`,
    ).bind(t, t).run();
    await env.DB.prepare(
      `INSERT INTO order_items (id,order_id,operator_id,appointment_id,client_id,
         starts_at,ends_at,duration_seconds,price_cents,address_released_at,created_at)
       VALUES ('i-w','o-w',?, 'a-w','c-w',?,?,3600,6500,?,?)`,
    ).bind(opId, t + 3600, t + 7200, released, t).run();
    await env.DB.prepare(
      `INSERT INTO job_leads (id,operator_id,client_id,title,address_line,postcode,lat,lng,
         urgency,status,created_at,updated_at)
       VALUES ('l-w',?,'c-w','Gutters',?, '91403',34.151,-118.445,2,'open',?,?)`,
    ).bind(opId, ADDRESS, t, t).run();
  }

  const listOf = async (path: string, key: string, cookie: string) => {
    const res = await call('GET', path, { cookie });
    expect(res.status).toBe(200);
    return ((await res.json()) as Record<string, any[]>)[key]!;
  };

  it('is withdrawn from the client list once the booking is cancelled', async () => {
    const op = await signIn('cl@example.com');
    await booked(op.opId, null);
    const [c] = await listOf('/api/clients', 'clients', op.cookie);
    expect(c.address_line).toBeNull();
    expect(c.lat).toBeNull();
    expect(c.lng).toBeNull();
    // What the operator still needs to run their book is untouched.
    expect(c.first_name).toBe('Rosa');
    expect(c.postcode).toBe('91403');
  });

  it('is withdrawn from the leads list too, where the lead keeps its own copy',
    async () => {
      const op = await signIn('ld@example.com');
      await booked(op.opId, null);
      const [l] = await listOf('/api/leads', 'leads', op.cookie);
      expect(l.address_line).toBeNull();
      expect(l.lat).toBeNull();
      expect(l.lng).toBeNull();
      expect(l.title).toBe('Gutters');
    });

  it('is still given out on both lists while the booking is live', async () => {
    const op = await signIn('live2@example.com');
    await booked(op.opId, now());
    // They have to drive there. A fix that hides a live booking's address is
    // not a fix, it is the product not working.
    const [c] = await listOf('/api/clients', 'clients', op.cookie);
    expect(c.address_line).toBe(ADDRESS);
    const [l] = await listOf('/api/leads', 'leads', op.cookie);
    expect(l.address_line).toBe(ADDRESS);
  });

  it('leaves an operator\'s own client alone, who has no release to withdraw',
    async () => {
      const op = await signIn('own2@example.com');
      const t = now();
      await env.DB.prepare(
        `INSERT INTO clients (id,operator_id,first_name,phone_e164,address_line,lat,lng,
           acquired,is_active,created_at,updated_at)
         VALUES ('c-mine',?,'Marta','+13105550188','4 Otter Lane',34.2,-118.5,
           'operator',1,?,?)`,
      ).bind(op.opId, t, t).run();
      const [c] = await listOf('/api/clients', 'clients', op.cookie);
      // No order item, so no release model: this is somebody out of their own
      // book whose address and number they typed in themselves.
      expect(c.address_line).toBe('4 Otter Lane');
      expect(c.phone_e164).toBe('+13105550188');
    });

  it('withholds the address when the query forgot to ask about the release', () => {
    // The remaining way to get this wrong is a new endpoint that selects a
    // doorstep and not the two columns that say whether it is still released.
    // Answering a question nobody asked with "yes" is how the first version of
    // this shipped, so the helper answers it with no.
    const masked = maskCustomerRow({
      id: 'x', acquired: 'public', address_line: ADDRESS, lat: 34.151, lng: -118.445,
    });
    expect(masked.address_line).toBeNull();
    expect(masked.lat).toBeNull();
    expect(masked.lng).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('a name a customer types is cut to a first name before it is stored', () => {
  /**
   * The checkout, the profile enquiry and the guest thread all took a name in
   * one free-text box and stored the answer whole, so "Jane Smith" — which is
   * what most people type when a form says "your name" — put a surname in
   * front of the business next to the address it is about to be given.
   *
   * Nothing can look at free text and tell a first name from a surname. What
   * is decidable is how much of it we asked for.
   */
  it('keeps the first word, whatever was typed', () => {
    expect(firstNameOnly('Jane Smith')).toBe('Jane');
    expect(firstNameOnly('  Jane   Smith  ')).toBe('Jane');
    expect(firstNameOnly('Jane')).toBe('Jane');
    // A hyphenated or apostrophed given name is one word and survives whole.
    expect(firstNameOnly("Mary-Jane O'Brien")).toBe('Mary-Jane');
    // "Smith, Jane" leaves punctuation on the word that is kept, and a stored
    // "Smith," reads to the operator as a typo we made.
    expect(firstNameOnly('Smith, Jane')).toBe('Smith');
    // Nothing is still nothing: the callers refuse an empty name and must go
    // on refusing it.
    expect(firstNameOnly('   ')).toBe('');
    expect(firstNameOnly(null)).toBe('');
  });

  it('cuts it on the conversation every public entry point opens', async () => {
    const op = await signIn('enq@example.com');
    const { thread } = await startThread(env, {
      operator_id: op.opId, guest_name: 'Jane Smith', first_message: 'Are you free Friday?',
    });
    // This line is what the operator reads at the top of the conversation.
    expect(thread.guest_name).toBe('Jane');

    const stored = await one<{ guest_name: string }>(
      `SELECT guest_name FROM threads WHERE id = ?`, thread.id);
    expect(stored?.guest_name).toBe('Jane');
  });

  it('still refuses a conversation opened under no name at all', async () => {
    const op = await signIn('enq2@example.com');
    await expect(startThread(env, { operator_id: op.opId, guest_name: '  ' }))
      .rejects.toThrow(/who you are/i);
  });
});

// ---------------------------------------------------------------------------
describe('the doorstep a cancellation could not reach: the notifications feed', () => {
  /**
   * The hole every other test in the file above would have missed.
   *
   * maskCustomerRow withdraws the street line from the schedule, the client
   * list and the leads list the moment a booking is cancelled, and fails closed
   * when a query forgets to ask. All three of those are reads: there is a row,
   * and there is a mask in front of it. A notification is neither. `notify()`
   * wrote "Thu, 12 Mar, 14:00-15:00 · $99 · 15200 Ventura Blvd" at the instant
   * the booking landed and stored the sentence, so cancelling withdrew the
   * address from every screen that reads a row and left it sitting in the one
   * that does not -- for the ninety days RETENTION.NOTIFICATION_DAYS keeps a
   * feed row, and past the point where the address had been swept off the
   * appointment, the order, the claim and the client alike.
   *
   * So these book through the real checkout, cancel through the button on the
   * operator's own schedule, and then read every operator-facing list there is
   * and look for the street line in the bytes. Asserting on parsed fields would
   * have passed on the old code: the address was never in a field, it was in a
   * sentence.
   */
  const ADDRESS = '15200 Ventura Blvd';
  const NEAR = { lat: 34.1510, lng: -118.4450 };

  /** Everything a real public checkout needs to exist first. */
  async function bookable(opId: string) {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,
         created_at,updated_at)
       VALUES ('sv-w',?,'Full detail',7200,9900,?,?)`,
    ).bind(opId, t, t).run();
    // The offline geocoder needs the ZIP to exist, same as in production.
    await env.DB.prepare(
      `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
       VALUES ('US','91403','Sherman Oaks',?,?,6)`,
    ).bind(NEAR.lat, NEAR.lng).run();
    const gapId = newId();
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,
         next_lat,next_lng,baseline_drive_seconds,is_mobile,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
    ).bind(gapId, opId, t + 4 * 3600, t + 9 * 3600,
      NEAR.lat, NEAR.lng, NEAR.lat, NEAR.lng, t, t).run();
    return gapId;
  }

  /** The checkout, exactly as the booking page drives it. */
  const book = (gapId: string) => placeOrder(env, {
    items: [{ gap_id: gapId, service_ids: ['sv-w'] }],
    guest_name: 'Rosa',
    phone: '(818) 555-0142',
    address_line: ADDRESS,
    postcode: '91403',
  });

  /**
   * Every operator-facing list, as raw bytes.
   *
   * Bytes rather than fields on purpose. The address was never a field on the
   * feed row -- it was three words inside a title-and-body pair -- so a test
   * that reads `.address_line` off each item is a test that would have watched
   * this ship.
   */
  async function everythingTheOperatorCanRead(cookie: string): Promise<string> {
    const t = now();
    const paths = [
      `/api/appointments?from=${t - 86400}&to=${t + 30 * 86400}`,
      '/api/clients',
      '/api/leads',
      '/api/notifications',
      '/api/threads',
      '/api/openings',
      '/api/parts/bookings',
      '/api/online/requests',
    ];
    const bodies = await Promise.all(paths.map(async (p) => {
      const res = await call('GET', p, { cookie });
      expect(res.status).toBe(200);
      return `${p}\n${await res.text()}`;
    }));
    return bodies.join('\n');
  }

  it('never freezes the street line into the feed row in the first place', async () => {
    const op = await signIn('feed1@example.com');
    const gapId = await bookable(op.opId);
    await book(gapId);

    const note = await one<{ title: string; body: string | null }>(
      `SELECT title, body FROM notifications WHERE operator_id = ?`, op.opId);
    // What the operator needs in a nudge: who, what, when and how much.
    expect(note?.title).toContain('Rosa');
    expect(note?.title).toContain('Full detail');
    expect(note?.body).toMatch(/\d{2}:\d{2}/);
    expect(note?.body).toContain('99');
    // And not the one thing nothing can take back.
    expect(note?.body ?? '').not.toContain(ADDRESS);
    expect(note?.body ?? '').not.toContain('Ventura');
  });

  it('still shows the doorstep everywhere while the booking is live', async () => {
    const op = await signIn('feed2@example.com');
    const gapId = await bookable(op.opId);
    await book(gapId);

    // They have to drive there. A fix that hides a live booking's address is
    // not a fix, it is the product not working.
    const seen = await everythingTheOperatorCanRead(op.cookie);
    expect(seen).toContain(ADDRESS);
  });

  it('withdraws it from every operator-facing response once it is cancelled',
    async () => {
      const op = await signIn('feed3@example.com');
      const gapId = await bookable(op.opId);
      const placed = await book(gapId);
      const item = placed.items[0]!;

      // The Cancel button on the operator's own schedule, which is the one an
      // operator actually presses.
      const res = await call('POST', `/api/appointments/${item.appointment_id}/cancel`,
        { cookie: op.cookie, body: { cancelled_by: 'client' } });
      expect(res.status).toBe(200);

      const seen = await everythingTheOperatorCanRead(op.cookie);
      expect(seen).not.toContain(ADDRESS);
      expect(seen).not.toContain('Ventura');
      // The coordinates are the address written differently.
      expect(seen).not.toContain('34.151');
      // The feed still tells them a booking was made and then called off; it
      // is only the doorstep that goes.
      expect(seen).toContain('Rosa');
    });

  it('withdraws it when the customer cancels from their own link too', async () => {
    const op = await signIn('feed4@example.com');
    const gapId = await bookable(op.opId);
    const placed = await book(gapId);
    const item = placed.items[0]!;

    const res = await call('POST',
      `/api/public/threads/${placed.thread_token}/cancel/${item.order_item_id}`,
      { body: { reason: 'Something came up' } });
    expect(res.status).toBe(200);

    const seen = await everythingTheOperatorCanRead(op.cookie);
    expect(seen).not.toContain(ADDRESS);
    expect(seen).not.toContain('Ventura');
  });

  it('filters the cancellation reason, which is the last box either side types in',
    async () => {
      const op = await signIn('feed8@example.com');
      const gapId = await bookable(op.opId);
      const placed = await book(gapId);
      const item = placed.items[0]!;

      // The one free-text field left that the chat filter did not read, written
      // at the exact moment somebody has the most reason to move the job off
      // the app -- and stored on the booking as well as quoted into the feed.
      const res = await call('POST',
        `/api/public/threads/${placed.thread_token}/cancel/${item.order_item_id}`,
        { body: { reason: 'Sorry — call me on (818) 555-0142 and we can rebook direct' } });
      expect(res.status).toBe(200);

      const stored = await one<{ cancel_reason: string }>(
        `SELECT cancel_reason FROM order_items WHERE id = ?`, item.order_item_id);
      expect(stored?.cancel_reason).not.toContain('555-0142');
      // Dropped, not rejected: the operator still learns they cancelled and why.
      expect(stored?.cancel_reason).toContain('we can rebook direct');

      const seen = await everythingTheOperatorCanRead(op.cookie);
      expect(seen).not.toContain('555-0142');
    });

  it('takes the feed rows with it when the customer asks to be erased', async () => {
    const op = await signIn('feed5@example.com');
    const gapId = await bookable(op.opId);
    const placed = await book(gapId);

    // Erasure emptied or deleted every row that named this person and left the
    // feed alone, so an operator told "they asked to be forgotten" could still
    // scroll their Bookings tab and read their name off it.
    await eraseCustomerByToken(env, placed.thread_token);

    const left = await one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM notifications WHERE operator_id = ?`, op.opId);
    expect(left?.n).toBe(0);
  });

  it('takes the address off the rows written before the code stopped writing it',
    async () => {
      // Every feed row already in the database was written by the old call
      // sites, and there is no read to put a mask in front of one. Migration
      // 0036 is the only thing that can reach them.
      const isNew = (p: string) => p.endsWith('0036_feed_no_doorstep.sql');
      const before = { ...makeEnv(ALL_MIGRATIONS.filter((p) => !isNew(p))) } as unknown as Env;

      const t = now();
      await before.DB.prepare(
        `INSERT INTO operators (id,email,business_name,timezone,country,currency,
           location_mode,fill_model,sms_mode,plan,created_at,updated_at)
         VALUES ('op-old','old@example.com','A Business','America/Los_Angeles','US','USD',
           'mobile','both','device','active',?,?)`,
      ).bind(t, t).run();
      await before.DB.prepare(
        `INSERT INTO notifications (id,operator_id,kind,title,body,created_at)
         VALUES ('n-book','op-old','public_booking','Rosa booked Full detail',?,?)`,
      ).bind(`Thu, 12 Mar, 14:00–15:00 · $99.00 · ${ADDRESS}`, t).run();
      await before.DB.prepare(
        `INSERT INTO notifications (id,operator_id,kind,title,body,created_at)
         VALUES ('n-chat','op-old','chat_message','Rosa sent you a message',
           'the side gate is unlocked',?)`,
      ).bind(t).run();

      await before.DB.exec(
        readFileSync(ALL_MIGRATIONS.find(isNew)!, 'utf8'));

      const booking = await before.DB.prepare(
        `SELECT title, body FROM notifications WHERE id = 'n-book'`,
      ).first<{ title: string; body: string | null }>();
      expect(booking?.body).toBeNull();
      // Who booked what is not the doorstep and is what makes the feed a feed.
      expect(booking?.title).toBe('Rosa booked Full detail');

      // Only the kind that ever carried a location. A chat excerpt is somebody
      // else's sentence and nothing here has any business editing it.
      const chat = await before.DB.prepare(
        `SELECT body FROM notifications WHERE id = 'n-chat'`,
      ).first<{ body: string | null }>();
      expect(chat?.body).toBe('the side gate is unlocked');
    });

  it('strips a contact detail out of anything the system writes into the feed',
    async () => {
      // The doorstep is the hole this change is about, and no pattern can find
      // one. A number or a mailbox can be found, so notify() runs the same
      // filter over its own text that a customer's typing goes through --
      // which is what stops the next line somebody assembles out of a
      // customer's details from freezing a number into a row nothing masks.
      const op = await signIn('feed6@example.com');
      await notify(env, op.opId, {
        kind: 'chat_message',
        title: 'Rosa sent you a message',
        body: 'call me on (818) 555-0142 or rosa@example.com',
      });

      const note = await one<{ body: string }>(
        `SELECT body FROM notifications WHERE operator_id = ?`, op.opId);
      expect(note?.body).not.toContain('555-0142');
      expect(note?.body).not.toContain('rosa@example.com');
      expect(note?.body).toContain('call me on');
    });

  it('leaves a price in a feed row alone, which is the reason that filter counts digits',
    async () => {
      const op = await signIn('feed7@example.com');
      await notify(env, op.opId, {
        kind: 'public_booking',
        title: 'Rosa booked Full detail',
        body: 'Thu, 12 Mar, 14:00–15:00 · $1,250.00',
      });

      const note = await one<{ body: string }>(
        `SELECT body FROM notifications WHERE operator_id = ?`, op.opId);
      expect(note?.body).toBe('Thu, 12 Mar, 14:00–15:00 · $1,250.00');
    });
});
