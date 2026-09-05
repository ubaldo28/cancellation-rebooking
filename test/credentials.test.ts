import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import {
  CONTRACTOR_THRESHOLD_LABEL, getCredentials, publishBlockers, rulesFor, saveCredentials,
} from '../src/lib/credentials';
import { now } from '../src/lib/util';

const MIGRATIONS = ALL_MIGRATIONS;

let env: Env;

/** One California operator, in a trade the test names. Nothing claimed yet. */
async function makeOperator(id: string, trade: string, businessName = 'Valley Works') {
  const n = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,phone_e164,timezone,country,
       currency,language,location_mode,fill_model,sms_mode,plan,is_published,
       created_at,updated_at)
     VALUES (?,?,?,?, '+18185550100','America/Los_Angeles','US','USD','en',
       'mobile','both','device','active',0,?,?)`,
  ).bind(id, `${id}@x.com`, businessName, trade, n, n).run();
}

const DAY = 86_400;

beforeEach(() => {
  env = makeEnv(MIGRATIONS) as unknown as Env;
});

describe('what a trade requires', () => {
  it('names the authority for work that is licensed outright', () => {
    expect(rulesFor('mobile locksmith').license).toBe('required');
    expect(rulesFor('mobile locksmith').authority).toBe('bsis');
    expect(rulesFor('mobile oil change and mechanics').license).toBe('required');
    expect(rulesFor('mobile oil change and mechanics').authority).toBe('bar');
    expect(rulesFor('pest control').license).toBe('required');
    expect(rulesFor('pest control').authority).toBe('spcb');
  });

  it('treats contractor work as licensed above the threshold', () => {
    for (const trade of ['mobile pressure washing', 'handyman and repair services', 'gutter cleaning',
                         'tree and shrub trimming', 'landscaping and gardening', 'pool service']) {
      expect(rulesFor(trade).license).toBe('over_threshold');
      expect(rulesFor(trade).authority).toBe('cslb');
      expect(rulesFor(trade).why).toContain(CONTRACTOR_THRESHOLD_LABEL);
    }
  });

  it('asks nothing of the trades no state licence covers', () => {
    for (const trade of ['mobile car wash and detailing', 'junk removal', 'trash can cleaning',
                         'bin cleaning', 'window cleaning', 'carpet cleaning',
                         'house cleaning', 'mobile pet grooming',
                         'mobile notary']) {
      expect(rulesFor(trade).license).toBe('none');
    }
  });

  it('makes electronics and appliance repair register with the bureau', () => {
    // Both used to be wrong in different directions: appliance repair was
    // filed as needing nothing at all, and phone repair did not exist. The
    // statute names them together -- Business and Professions Code 9801 covers
    // "cellular device, such as a telephone or tablet" alongside major home
    // appliances, and 9840 makes acting as a service dealer without
    // registering unlawful. There is no exemption for a sole trader.
    for (const trade of ['phone and tablet repair', 'appliance repair']) {
      expect(rulesFor(trade).license).toBe('required');
      expect(rulesFor(trade).authority).toBe('bhgs');
    }
  });

  it('calls the bureau requirement a registration, not a licence', () => {
    // The word decides whether somebody signs up. "Licence" implies an exam
    // and years of qualification; this is a form and a fee, and an operator
    // who believes the first one closes the page.
    const why = rulesFor('phone and tablet repair').why;
    expect(why).toMatch(/registration rather than a trade licence/i);
    expect(why).toMatch(/no exam/i);
    expect(why).toMatch(/sole trader/i);
  });

  it('defaults an unknown trade to no requirement, never to a licence', () => {
    // A wrong "you need a licence" stops a legitimate business over something
    // nobody can point at.
    for (const trade of ['sword sharpening', '', '   ', null, undefined]) {
      expect(rulesFor(trade).license).toBe('none');
      expect(rulesFor(trade).authority).toBeUndefined();
    }
  });

  it('matches the trade however it was typed', () => {
    expect(rulesFor('  Mobile Locksmith ').license).toBe('required');
  });
});

describe('publishing', () => {
  it('blocks a locksmith with no licence, and says who licenses them', async () => {
    await makeOperator('op1', 'mobile locksmith');
    const blockers = await publishBlockers(env, 'op1');
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/Bureau of Security and Investigative Services/);
  });

  it('lets a locksmith through once the licence is on the record', async () => {
    await makeOperator('op1', 'mobile locksmith');
    await saveCredentials(env, 'op1', {
      license_kind: 'bsis', license_number: 'LCO 5512', license_state: 'CA',
    });
    expect(await publishBlockers(env, 'op1')).toEqual([]);
  });

  it('does not block a detailer who has no licence', async () => {
    await makeOperator('op1', 'mobile car wash and detailing');
    expect(await publishBlockers(env, 'op1')).toEqual([]);
  });

  it('blocks contractor work with neither a licence nor the acknowledgement', async () => {
    await makeOperator('op1', 'mobile pressure washing');
    const blockers = await publishBlockers(env, 'op1');
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain(CONTRACTOR_THRESHOLD_LABEL);
    expect(blockers[0]).toMatch(/Contractors State License Board/);
  });

  it('clears contractor work once a licence is supplied', async () => {
    await makeOperator('op1', 'mobile pressure washing');
    await saveCredentials(env, 'op1', {
      license_kind: 'cslb', license_number: '1084433', license_state: 'CA',
    });
    expect(await publishBlockers(env, 'op1')).toEqual([]);
  });

  it('clears contractor work once they acknowledge working unlicensed', async () => {
    await makeOperator('op1', 'mobile pressure washing');
    await saveCredentials(env, 'op1', { license_kind: 'none', unlicensed_ack: 1 });
    expect(await publishBlockers(env, 'op1')).toEqual([]);
  });

  it('blocks a licence that has expired since it was entered', async () => {
    await makeOperator('op1', 'mobile locksmith');
    await saveCredentials(env, 'op1', {
      license_kind: 'bsis', license_number: 'LCO 5512',
      license_expires_at: now() + 30 * DAY,
    });
    expect(await publishBlockers(env, 'op1')).toEqual([]);

    // Time passes and the licence lapses where it sits. Written straight to the
    // row because saveCredentials refuses a date already in the past.
    await env.DB.prepare(
      `UPDATE operators SET license_expires_at = ? WHERE id = 'op1'`,
    ).bind(now() - DAY).run();

    const blockers = await publishBlockers(env, 'op1');
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/expired on \d{4}-\d{2}-\d{2}/);
  });

  it('blocks insurance that has lapsed, and only when some was claimed', async () => {
    await makeOperator('op1', 'mobile car wash and detailing');
    await saveCredentials(env, 'op1', {
      insurer: 'Golden State Mutual', policy_number: 'GS-99120',
      insurance_expires_at: now() + 30 * DAY, insured_ack: 1,
    });
    expect(await publishBlockers(env, 'op1')).toEqual([]);

    await env.DB.prepare(
      `UPDATE operators SET insurance_expires_at = ? WHERE id = 'op1'`,
    ).bind(now() - DAY).run();

    const blockers = await publishBlockers(env, 'op1');
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/insurance/i);
  });

  it('says nothing about insurance nobody claimed', async () => {
    await makeOperator('op1', 'mobile car wash and detailing');
    expect(await publishBlockers(env, 'op1')).toEqual([]);
  });

  it('asks nothing of a trade none of the rules name', async () => {
    await makeOperator('op1', 'sword sharpening');
    expect(await publishBlockers(env, 'op1')).toEqual([]);
  });

  it('refuses an operator that does not exist', async () => {
    await expect(publishBlockers(env, 'nobody')).rejects.toThrow();
  });
});

describe('saving what a business claims', () => {
  beforeEach(async () => {
    await makeOperator('op1', 'mobile locksmith');
  });

  it('starts blank, with the licence unanswered rather than absent', async () => {
    const c = await getCredentials(env, 'op1');
    // NULL is "not answered yet", which is not the same as "no licence needed".
    expect(c.license_kind).toBeNull();
    expect(c.license_number).toBeNull();
    expect(c.unlicensed_ack).toBe(0);
    expect(c.insured_ack).toBe(0);
  });

  it('keeps what it was given', async () => {
    const c = await saveCredentials(env, 'op1', {
      license_kind: 'bsis', license_number: 'LCO 5512', license_state: 'CA',
      license_expires_at: now() + 200 * DAY,
      insurer: 'Golden State Mutual', policy_number: 'GS-99120', insured_ack: true,
    });
    expect(c.license_kind).toBe('bsis');
    expect(c.license_number).toBe('LCO 5512');
    expect(c.license_state).toBe('CA');
    expect(c.insurer).toBe('Golden State Mutual');
    expect(c.insured_ack).toBe(1);
  });

  it('leaves out of a partial save what the caller left out', async () => {
    await saveCredentials(env, 'op1', { license_kind: 'bsis', license_number: 'LCO 5512' });
    const c = await saveCredentials(env, 'op1', { insurer: 'Golden State Mutual' });
    expect(c.license_number).toBe('LCO 5512');
    expect(c.insurer).toBe('Golden State Mutual');
  });

  it('wants a licence number whenever a licence is claimed', async () => {
    await expect(saveCredentials(env, 'op1', { license_kind: 'bsis' }))
      .rejects.toThrow(/licence number/i);
  });

  it('refuses a number nobody could look up', async () => {
    for (const number of ['1', '000000', 'n/a', '-']) {
      await expect(saveCredentials(env, 'op1', { license_kind: 'bsis', license_number: number }))
        .rejects.toThrow(/does not look like a licence number|licence number/i);
    }
  });

  it('says which date has already passed', async () => {
    await expect(saveCredentials(env, 'op1', {
      license_kind: 'bsis', license_number: 'LCO 5512',
      license_expires_at: now() - DAY,
    })).rejects.toThrow(/licence expiry date/i);

    await expect(saveCredentials(env, 'op1', {
      insurance_expires_at: now() - DAY,
    })).rejects.toThrow(/insurance expiry date/i);
  });

  it('refuses a licence kind it does not know how to record', async () => {
    await expect(saveCredentials(env, 'op1', {
      license_kind: 'faa', license_number: '1084433',
    })).rejects.toThrow();
  });

  it('clears the number when the answer becomes "no state licence"', async () => {
    await saveCredentials(env, 'op1', { license_kind: 'bsis', license_number: 'LCO 5512' });
    const c = await saveCredentials(env, 'op1', { license_kind: 'none' });
    // A number left sitting under "none" is a claim nobody made.
    expect(c.license_number).toBeNull();
    expect(c.license_expires_at).toBeNull();
  });

  it('defaults the state to California', async () => {
    const c = await saveCredentials(env, 'op1', {
      license_kind: 'bsis', license_number: 'LCO 5512',
    });
    expect(c.license_state).toBe('CA');
  });

  it('refuses an operator that does not exist', async () => {
    await expect(saveCredentials(env, 'nobody', { license_kind: 'none' })).rejects.toThrow();
    await expect(getCredentials(env, 'nobody')).rejects.toThrow();
  });
});

describe('one operator and another', () => {
  beforeEach(async () => {
    await makeOperator('op1', 'mobile locksmith', 'Valley Locks');
    await makeOperator('op2', 'mobile locksmith', 'Sunset Locks');
    await saveCredentials(env, 'op2', {
      license_kind: 'bsis', license_number: 'LCO 7001', license_state: 'CA',
    });
  });

  it('reads only its own', async () => {
    expect((await getCredentials(env, 'op1')).license_number).toBeNull();
    expect((await getCredentials(env, 'op2')).license_number).toBe('LCO 7001');
  });

  it('cannot write over another operator\'s licence', async () => {
    await saveCredentials(env, 'op1', { license_kind: 'none', unlicensed_ack: 1 });
    const theirs = await getCredentials(env, 'op2');
    expect(theirs.license_kind).toBe('bsis');
    expect(theirs.license_number).toBe('LCO 7001');
    expect(theirs.unlicensed_ack).toBe(0);
  });

  it('does not borrow another operator\'s licence to get published', async () => {
    // op2 holds a licence; op1 holds nothing, and is blocked on its own record.
    expect(await publishBlockers(env, 'op2')).toEqual([]);
    expect(await publishBlockers(env, 'op1')).toHaveLength(1);
  });
});
