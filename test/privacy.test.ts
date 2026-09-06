import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { redactContact } from '../src/lib/redact';
import { startThread } from '../src/lib/chat';
import { sendQuote } from '../src/lib/parts';
import { leaveReview, replyToReview } from '../src/lib/reviews';
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
