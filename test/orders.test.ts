import { describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import { placeOrder, priceOrder } from '../src/lib/orders';
import { postOpening } from '../src/lib/openings';
import { DEMO_OPERATOR_ID } from '../src/lib/demo';
import { type HttpError, newId, now } from '../src/lib/util';

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
    // stripe_payouts_enabled = 1 is load-bearing, not boilerplate: a business
    // must have somewhere to be paid before its work can be sold, so priceOrder
    // treats an opening for an operator without it as unlisted. Drop it and
    // every booking in this file comes back slot_gone.
    await env.DB.prepare(
      `INSERT INTO operators (id,email,business_name,timezone,country,currency,language,
         location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
         offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
         discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at,
         stripe_payouts_enabled)
       VALUES (?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
         3600,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?,1)`,
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
      `INSERT INTO public_claims (id,operator_id,gap_id,status,created_at,updated_at)
       VALUES (?,?,?,'confirmed',?,?)`,
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
          `INSERT INTO public_claims (id,operator_id,gap_id,status,created_at,updated_at)
           VALUES (?,?,?,'confirmed',?,?)`,
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

// ---------------------------------------------------------------------------
describe('the checkout takes a first name, and takes only that', () => {
  /**
   * The box said "Your name" and whatever was typed into it was written whole:
   * onto the order, onto the operator's own client row, onto the claim and
   * onto the conversation. So the very common answer "Jane Smith" handed the
   * business a surname beside the street address it was about to be given —
   * which is the pair redact.ts deletes last_name to prevent, undone by the
   * busiest form in the product.
   *
   * The field now asks for a first name and says why. These are about the half
   * that has to be true whatever the field says, because a form is a
   * suggestion and this is the server.
   */
  const FULL = { ...BUYER, guest_name: 'Jane Smith' };

  it('keeps the first word and never writes the rest down', async () => {
    const { detailerSlot } = await seed();
    const placed = await placeOrder(env, {
      ...FULL, items: [{ gap_id: detailerSlot, service_ids: ['a-wash'] }],
    });

    const order = await env.DB.prepare(`SELECT guest_name FROM orders WHERE id = ?`)
      .bind(placed.order_id).first<{ guest_name: string }>();
    expect(order?.guest_name).toBe('Jane');

    // The row the operator actually reads. This is the one the promise is
    // about: a first name and a street address is a customer, a full name and
    // a street address is an identity.
    const client = await env.DB.prepare(`SELECT first_name, last_name FROM clients`)
      .first<{ first_name: string; last_name: string | null }>();
    expect(client?.first_name).toBe('Jane');
    expect(client?.last_name).toBeNull();

    const thread = await env.DB.prepare(`SELECT guest_name FROM threads`)
      .first<{ guest_name: string }>();
    expect(thread?.guest_name).toBe('Jane');
  });

  it('leaves no copy of the surname anywhere in the database', async () => {
    const { detailerSlot } = await seed();
    await placeOrder(env, {
      ...FULL, items: [{ gap_id: detailerSlot, service_ids: ['a-wash'] }],
    });

    // Every table the checkout writes to, asked the blunt question. A single
    // column that still carries it is the whole failure, and naming them one
    // by one is how a new one gets missed.
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'`,
    ).all<{ name: string }>();
    for (const { name } of tables.results ?? []) {
      const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>();
      expect(JSON.stringify(rows.results ?? []), `${name} still holds it`)
        .not.toContain('Smith');
    }
  });

  it('is not fooled by the spacing somebody types', async () => {
    const { detailerSlot } = await seed();
    const placed = await placeOrder(env, {
      ...BUYER, guest_name: '  Jane   Smith  ',
      items: [{ gap_id: detailerSlot, service_ids: ['a-wash'] }],
    });
    const order = await env.DB.prepare(`SELECT guest_name FROM orders WHERE id = ?`)
      .bind(placed.order_id).first<{ guest_name: string }>();
    expect(order?.guest_name).toBe('Jane');
  });

  it('still refuses a booking with no name at all', async () => {
    const { detailerSlot } = await seed();
    // Cutting a name down must not turn an empty box into a booking under no
    // name, which is what a naive "take the first word" would do.
    await expect(placeOrder(env, {
      ...BUYER, guest_name: '   ',
      items: [{ gap_id: detailerSlot, service_ids: ['a-wash'] }],
    })).rejects.toThrow(/name/i);
  });
});

// ---------------------------------------------------------------------------
describe('the claim row holds nothing that could reach the customer', () => {
  /**
   * public_claims decides the booking race and carries an operator_id. Until
   * migration 0035 it also carried the customer's first name, phone number and
   * email address in full — read by nothing, since every query against it is
   * an EXISTS or a COUNT, and therefore harmless right up until the first
   * `SELECT *` somebody writes for a dashboard. That query would hand a
   * business the contact details this entire product exists to withhold.
   */
  it('has no column that could carry a name, a number or a mailbox', async () => {
    await seed();
    const cols = await env.DB.prepare(`PRAGMA table_info(public_claims)`)
      .all<{ name: string }>();
    const names = (cols.results ?? []).map((c) => c.name);
    // Named individually rather than pattern-matched: these three are the ones
    // that were there, and a column that cannot be written cannot leak.
    expect(names).not.toContain('phone_e164');
    expect(names).not.toContain('email');
    expect(names).not.toContain('first_name');
  });

  it('survives the query it was always one line away from', async () => {
    const { detailerSlot } = await seed();
    await placeOrder(env, {
      ...BUYER, guest_name: 'Rosa', email: 'rosa@example.com',
      items: [{ gap_id: detailerSlot, service_ids: ['a-wash'] }],
    });

    // The dashboard query nobody has written yet, run here so it can never
    // become the way this is found out.
    const rows = await env.DB.prepare(
      `SELECT * FROM public_claims WHERE operator_id = ?`,
    ).bind(DETAILER).all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(1);

    const body = JSON.stringify(rows.results);
    expect(body).not.toContain('8185550142');
    expect(body).not.toContain('rosa@example.com');
    expect(body).not.toContain('Rosa');

    // The number is still on the order, which is the platform's own record and
    // carries no operator_id. It is what an operator rings on arrival, and
    // taking it off the order would cost a business the way to reach the
    // doorstep it is driving to. What the standing ladder counts against and
    // what erasure follows is login_email since migration 0038 — see the test
    // below, which erases through it — and neither may be weakened by this.
    const order = await env.DB.prepare(`SELECT phone_e164 FROM orders`)
      .first<{ phone_e164: string }>();
    expect(order?.phone_e164).toBe('+18185550142');
  });

  it('can still be found and emptied by the address when somebody asks to be erased',
    async () => {
      const { detailerSlot } = await seed();
      const placed = await placeOrder(env, {
        ...BUYER,
        // The account a real checkout resolves before a single row is written.
        // The proved address on it is what the erasure below follows back to
        // this claim; the number typed into the form reaches nothing, which
        // since 0038 is exactly the point.
        account: {
          id: 'acct-rosa', phone: '+18185550142', login_email: 'rosa@mailbox.test',
        },
        items: [{ gap_id: detailerSlot, service_ids: ['a-wash'] }],
      });

      const { eraseCustomerByToken } = await import('../src/lib/retention');
      await eraseCustomerByToken(env, placed.thread_token);

      // The row stays — its unique index on gap_id is the double-booking guard
      // — and everything that led back to a person is gone from it.
      const claim = await env.DB.prepare(
        `SELECT phone_hash, address_line, lat FROM public_claims`,
      ).first<{ phone_hash: string | null; address_line: string | null; lat: number | null }>();
      expect(claim).not.toBeNull();
      expect(claim?.phone_hash).toBeNull();
      expect(claim?.address_line).toBeNull();
      expect(claim?.lat).toBeNull();
    });
});

describe('an opening with nobody to pay, refused for the right reason', () => {
  /**
   * One of lib/demo.ts's seeded businesses, with an opening on it.
   *
   * stripe_payouts_enabled is 0 and that is the honest value rather than a
   * shortcut: not one of the sample businesses has a Stripe account, because
   * not one of them is a business. It is also the whole reason this fixture is
   * worth having. The sample check and the payout check both match this row, so
   * only their ORDER decides which sentence a customer is given — and a fixture
   * that quietly handed the sample a payout account would pass either way round
   * and pin nothing.
   */
  async function sampleSlot(): Promise<string> {
    const n = now();
    await env.DB.prepare(
      `INSERT INTO operators (id,email,business_name,timezone,country,currency,language,
         location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
         offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
         discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at,
         stripe_payouts_enabled)
       VALUES (?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
         3600,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?,0)`,
    ).bind(DEMO_OPERATOR_ID, 'demo@roundtheway.app',
      'Valley Shine Mobile Detailing', n, n).run();

    await env.DB.prepare(
      `INSERT INTO services (id,operator_id,name,duration_seconds,price_cents,created_at,updated_at)
       VALUES ('sample-detail',?,'Full detail',7200,18900,?,?)`,
    ).bind(DEMO_OPERATOR_ID, n, n).run();

    const id = newId();
    await env.DB.prepare(
      `INSERT INTO gaps (id,operator_id,starts_at,ends_at,prev_lat,prev_lng,next_lat,next_lng,
         baseline_drive_seconds,is_mobile,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,180,1,'open',?,?)`,
    ).bind(id, DEMO_OPERATOR_ID, n + 4 * 3600, n + 9 * 3600,
      PREV.lat, PREV.lng, NEXT.lat, NEXT.lng, n, n).run();
    return id;
  }

  it('says a sample business is sample data, and says whose listing it is', async () => {
    await seed();
    const gapId = await sampleSlot();

    const priced = await priceOrder(env, [
      { gap_id: gapId, service_ids: ['sample-detail'] },
    ]);

    // NOT slot_gone, and that is the point of the whole branch. The opening is
    // on the map the customer is looking at as they read the answer, so "no
    // longer listed" was false where they were standing and sent them off to
    // wait for a relisting that is never coming. Before anybody has signed up
    // every opening on the map is one of these, so this was the answer to the
    // commonest tap in the product.
    const codes = priced.items[0]!.problems.map((p) => p.code);
    expect(codes).toEqual(['sample_listing']);
    expect(codes).not.toContain('slot_gone');

    // The name is in the sentence because a refusal that does not say WHICH of
    // the nine lines in a basket is the seeded one cannot be acted on.
    expect(priced.items[0]!.problems[0]!.message)
      .toContain('Valley Shine Mobile Detailing');
    expect(priced.ok).toBe(false);

    // And the checkout refuses with the same code rather than a 409: nothing
    // raced and nothing changed underneath anybody — this was never for sale.
    const refused = await placeOrder(env, {
      ...BUYER, items: [{ gap_id: gapId, service_ids: ['sample-detail'] }],
    }).catch((e: HttpError) => e);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as HttpError).code).toBe('sample_listing');
    expect((refused as HttpError).status).toBe(400);
  });

  it('tells a stranger nothing about a real business with no bank account', async () => {
    const { detailerSlot } = await seed();
    // A real operator whose Stripe account has gone bad. Same unbookable state
    // as the sample above, and deliberately the opposite answer.
    await env.DB.prepare(`UPDATE operators SET stripe_payouts_enabled = 0 WHERE id = ?`)
      .bind(DETAILER).run();

    const priced = await priceOrder(env, [
      { gap_id: detailerSlot, service_ids: ['a-detail'] },
    ]);

    const problem = priced.items[0]!.problems[0]!;
    expect(problem.code).toBe('slot_gone');
    expect(problem.message).toBe('That opening is no longer listed.');

    // THE VAGUE ANSWER IS THE KIND ONE, and it is checked rather than assumed.
    // There is a person behind this business whose banking is nobody else's
    // business, least of all a stranger's who tapped an opening. A later
    // "helpful" rewrite of this branch — "this business cannot take payments
    // yet" — would be the platform telling the public that somebody's bank
    // arrangements have fallen over. See the comment on `unpayable` in
    // src/lib/orders.ts.
    expect(problem.message).not.toMatch(/payout|bank|stripe|account/i);
    // Nor anywhere else in what the customer is handed back.
    expect(JSON.stringify(priced)).not.toMatch(/payout|stripe/i);
  });
});
