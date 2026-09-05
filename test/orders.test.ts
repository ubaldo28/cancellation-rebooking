import { describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { placeOrder, priceOrder } from '../src/lib/orders';
import { postOpening } from '../src/lib/openings';
import { newId, now } from '../src/lib/util';

const MIGRATIONS = ALL_MIGRATIONS;

let env: Env;

// Two different businesses, so a basket can genuinely span them.
const DETAILER = 'op-detail';
const BARBER = 'op-barber';

const PREV = { lat: 34.1500, lng: -118.4490 };
const NEXT = { lat: 34.1520, lng: -118.4400 };
const NEAR = { lat: 34.1510, lng: -118.4450 };

const BUYER = {
  guest_name: 'Rosa',
  phone: '(818) 555-0142',
  address_line: '15200 Ventura Blvd',
  postcode: '91403',
};

const count = async (sql: string) =>
  (await env.DB.prepare(sql).first<{ n: number }>())!.n;

async function seed() {
  env = makeEnv(MIGRATIONS) as unknown as Env;
  const n = now();

  for (const [id, email, name] of [
    [DETAILER, 'a@x.com', 'Valley Detailing'],
    [BARBER, 'b@x.com', 'Encino Barbers'],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO operators (id,email,business_name,timezone,country,currency,language,
         location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
         offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
         discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at)
       VALUES (?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
         3600,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?)`,
    ).bind(id, email, name, n, n).run();
  }

  for (const [id, op, name, secs, cents] of [
    ['a-detail', DETAILER, 'Full detail', 7200, 9900],
    ['a-wash', DETAILER, 'Wash only', 3600, 4900],
    ['b-cut', BARBER, 'Cut and beard', 1800, 3500],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(id, op, name, secs, cents, n, n).run();
  }

  // The offline geocoder needs the ZIP to exist, same as in production.
  await env.DB.prepare(
    `INSERT INTO postal_codes (country_code,postal_code,place_name,lat,lng,accuracy)
     VALUES ('US','91403','Sherman Oaks',?,?,6)`,
  ).bind(NEAR.lat, NEAR.lng).run();

  const openGap = async (operatorId: string, offset: number, length: number) => {
    const id = newId();
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
         baseline_drive_seconds,is_mobile,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
    ).bind(id, operatorId, n + offset, n + offset + length,
      PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();
    return id;
  };

  return {
    n,
    // Today.
    detailerSlot: await openGap(DETAILER, 4 * 3600, 5 * 3600),
    // A future date, at a different business.
    barberSlot: await openGap(BARBER, 30 * 3600, 5 * 3600),
    // An hour is not enough for what the tests try to put in it.
    shortSlot: await openGap(DETAILER, 60 * 3600, 3600),
  };
}

describe('pricing a basket', () => {
  it('sums the duration and the price of several services', async () => {
    const { detailerSlot } = await seed();
    const priced = await priceOrder(env, [
      { gap_id: detailerSlot, service_ids: ['a-detail', 'a-wash'] },
    ]);

    expect(priced.items[0]!.duration_seconds).toBe(7200 + 3600);
    expect(priced.items[0]!.price_cents).toBe(9900 + 4900);
    expect(priced.items[0]!.fits).toBe(true);
    expect(priced.total_cents).toBe(14800);
    expect(priced.ok).toBe(true);
  });

  it('writes nothing — the customer has not committed to anything yet', async () => {
    const { detailerSlot } = await seed();
    await priceOrder(env, [{ gap_id: detailerSlot, service_ids: ['a-detail', 'a-wash'] }]);
    expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM appointments`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM public_claims`)).toBe(0);
  });

  it('reports an order that is too long for its slot instead of trimming it', async () => {
    const { shortSlot } = await seed();
    const priced = await priceOrder(env, [
      { gap_id: shortSlot, service_ids: ['a-detail', 'a-wash'] },
    ]);
    expect(priced.items[0]!.fits).toBe(false);
    expect(priced.ok).toBe(false);
    expect(priced.items[0]!.problems.map((p) => p.code)).toContain('too_long');

    await expect(placeOrder(env, {
      ...BUYER, items: [{ gap_id: shortSlot, service_ids: ['a-detail', 'a-wash'] }],
    })).rejects.toThrow(/minutes more/i);
  });

  it('honours the services the operator attached to a posted slot', async () => {
    const { n } = await seed();
    const opening = await postOpening(env, DETAILER, {
      starts_at: n + 100 * 3600, ends_at: n + 105 * 3600, service_ids: ['a-wash'],
    });

    const allowed = await priceOrder(env, [{ gap_id: opening.id, service_ids: ['a-wash'] }]);
    expect(allowed.ok).toBe(true);

    const refused = await priceOrder(env, [{ gap_id: opening.id, service_ids: ['a-detail'] }]);
    expect(refused.items[0]!.problems.map((p) => p.code)).toContain('service_not_in_slot');

    const foreign = await priceOrder(env, [{ gap_id: opening.id, service_ids: ['b-cut'] }]);
    expect(foreign.items[0]!.problems.map((p) => p.code)).toContain('bad_service');
  });

  it('refuses an order that mixes two currencies', async () => {
    const { detailerSlot, barberSlot } = await seed();
    await env.DB.prepare(`UPDATE operators SET currency='GBP' WHERE id=?`).bind(BARBER).run();

    const items = [
      { gap_id: detailerSlot, service_ids: ['a-detail'] },
      { gap_id: barberSlot, service_ids: ['b-cut'] },
    ];

    const priced = await priceOrder(env, items);
    expect(priced.ok).toBe(false);
    expect(priced.problems.map((p) => p.code)).toContain('mixed_currency');
    // No invented total: 99 USD plus 35 GBP is not 134 of anything.
    expect(priced.total_cents).toBe(0);
    expect(priced.currency).toBeNull();

    await expect(placeOrder(env, { ...BUYER, items })).rejects.toThrow(/currency/i);
    expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBe(0);
  });
});

describe('placing an order', () => {
  it('claims two slots at two different businesses in one checkout', async () => {
    const { detailerSlot, barberSlot } = await seed();
    const order = await placeOrder(env, {
      ...BUYER,
      items: [
        { gap_id: detailerSlot, service_ids: ['a-detail', 'a-wash'] },
        { gap_id: barberSlot, service_ids: ['b-cut'] },
      ],
    });

    // No payment step exists yet, so 'pending' is the honest state.
    expect(order.status).toBe('pending');
    expect(order.currency).toBe('USD');
    expect(order.total_cents).toBe(9900 + 4900 + 3500);
    expect(order.items.map((i) => i.operator_id)).toEqual([DETAILER, BARBER]);

    expect(await count(`SELECT COUNT(*) AS n FROM appointments WHERE status='scheduled'`)).toBe(2);
    expect(await count(`SELECT COUNT(*) AS n FROM public_claims WHERE status='confirmed'`)).toBe(2);
    expect(await count(`SELECT COUNT(*) AS n FROM gaps WHERE status='filled'`)).toBe(2);
    expect(await count(`SELECT COUNT(*) AS n FROM order_items`)).toBe(2);
    expect(await count(`SELECT COUNT(*) AS n FROM order_item_services`)).toBe(3);

    // One client per business — clients belong to an operator, and two slots
    // at the same business are one person on that business's list.
    expect(await count(`SELECT COUNT(*) AS n FROM clients`)).toBe(2);

    // A conversation per business, because there is no shared inbox.
    expect(order.threads).toHaveLength(2);
    expect(order.thread_token).toBeTruthy();

    const row = await env.DB.prepare(`SELECT * FROM orders`).first<any>();
    expect(row.total_cents).toBe(18300);
    expect(row.currency).toBe('USD');
    expect(row.thread_token_hash).toBeTruthy();

    // The receipt holds its own copy of every service, so a later rename or
    // reprice cannot rewrite what was agreed.
    const lines = await env.DB.prepare(
      `SELECT name, price_cents, duration_seconds FROM order_item_services`).all<any>();
    expect(lines.results!.map((l) => l.name).sort())
      .toEqual(['Cut and beard', 'Full detail', 'Wash only']);

    // The appointment covers everything bought, at the total price.
    const appt = await env.DB.prepare(
      `SELECT starts_at, ends_at, price_cents FROM appointments ORDER BY starts_at`).all<any>();
    expect(appt.results![0]!.ends_at - appt.results![0]!.starts_at).toBe(10800);
    expect(appt.results![0]!.price_cents).toBe(14800);
  });

  it('puts two slots at the same business on one client record', async () => {
    const { n, detailerSlot } = await seed();
    const second = newId();
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
         baseline_drive_seconds,is_mobile,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
    ).bind(second, DETAILER, n + 80 * 3600, n + 84 * 3600,
      PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();

    await placeOrder(env, {
      ...BUYER,
      items: [
        { gap_id: detailerSlot, service_ids: ['a-wash'] },
        { gap_id: second, service_ids: ['a-wash'] },
      ],
    });

    expect(await count(`SELECT COUNT(*) AS n FROM clients`)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM appointments`)).toBe(2);
  });

  it('says so up front when one of the slots has already gone', async () => {
    const { n, detailerSlot, barberSlot } = await seed();
    await env.DB.prepare(
      `INSERT INTO public_claims (id,operator_id,gap_id,first_name,phone_e164,status,created_at,updated_at)
       VALUES (?,?,?,'Dan','+18185550199','confirmed',?,?)`,
    ).bind(newId(), BARBER, barberSlot, n, n).run();

    await expect(placeOrder(env, {
      ...BUYER,
      items: [
        { gap_id: detailerSlot, service_ids: ['a-detail'] },
        { gap_id: barberSlot, service_ids: ['b-cut'] },
      ],
    })).rejects.toThrow(/just been taken/i);

    expect(await count(`SELECT COUNT(*) AS n FROM appointments`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBe(0);
  });

  it('fails the whole order and claims nothing when a slot goes mid-checkout', async () => {
    const { n, detailerSlot, barberSlot } = await seed();

    // The race the unique index exists for: somebody else confirms a claim on
    // the barber's slot in the moment between pricing this basket and writing
    // it. The customer chose two things; they must end up with neither, not
    // with the detailing they only wanted alongside the haircut.
    const db = env.DB as any;
    const realBatch = db.batch.bind(db);
    let raced = false;
    db.batch = async (statements: any[]) => {
      if (!raced) {
        raced = true;
        await realBatch([env.DB.prepare(
          `INSERT INTO public_claims (id,operator_id,gap_id,first_name,phone_e164,status,created_at,updated_at)
           VALUES (?,?,?,'Dan','+18185550199','confirmed',?,?)`,
        ).bind(newId(), BARBER, barberSlot, n, n)]);
      }
      return realBatch(statements);
    };

    try {
      await expect(placeOrder(env, {
        ...BUYER,
        items: [
          { gap_id: detailerSlot, service_ids: ['a-detail'] },
          { gap_id: barberSlot, service_ids: ['b-cut'] },
        ],
      })).rejects.toThrow(/taken/i);
    } finally {
      db.batch = realBatch;
    }

    // Nothing at all was written — not the appointment for the slot that was
    // still free, not the order, not the client.
    expect(await count(`SELECT COUNT(*) AS n FROM appointments`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM order_items`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM clients`)).toBe(0);
    // Only the interloper's.
    expect(await count(`SELECT COUNT(*) AS n FROM public_claims WHERE status='confirmed'`)).toBe(1);

    const gap = await env.DB.prepare(`SELECT status FROM gaps WHERE id=?`)
      .bind(detailerSlot).first<{ status: string }>();
    expect(gap!.status).toBe('open');
  });

  it('refuses a basket with nothing chosen, or the same slot twice', async () => {
    const { detailerSlot } = await seed();
    expect((await priceOrder(env, [])).problems.map((p) => p.code)).toContain('empty_order');

    const nothing = await priceOrder(env, [{ gap_id: detailerSlot, service_ids: [] }]);
    expect(nothing.items[0]!.problems.map((p) => p.code)).toContain('no_service');

    const twice = await priceOrder(env, [
      { gap_id: detailerSlot, service_ids: ['a-wash'] },
      { gap_id: detailerSlot, service_ids: ['a-wash'] },
    ]);
    expect(twice.items[1]!.problems.map((p) => p.code)).toContain('duplicate_gap');
  });

  it('still insists on a name, a real number and an address it can reach', async () => {
    const { detailerSlot } = await seed();
    const items = [{ gap_id: detailerSlot, service_ids: ['a-wash'] }];

    await expect(placeOrder(env, { guest_name: 'Rosa', phone: '8185550142', items }))
      .rejects.toThrow(/address/i);
    await expect(placeOrder(env, { ...BUYER, phone: '12', items }))
      .rejects.toThrow(/valid mobile/i);
    await expect(placeOrder(env, { ...BUYER, guest_name: '   ', items }))
      .rejects.toThrow(/name/i);
  });
});
