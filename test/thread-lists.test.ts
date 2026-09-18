import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import worker from '../src/index';
import type { Env } from '../src/types';
import { signInCustomer } from './customer';
import {
  listThreads, listThreadsForCustomer, markThreadRead, postAsGuest, postAsOperator,
  setThreadStatus, startThread, unreadThreadCountForCustomer,
} from '../src/lib/chat';
import { newId, now } from '../src/lib/util';

/**
 * TWO CONVERSATION LISTS THAT HAVE TO SURVIVE BEING BUSY.
 *
 * The owner's description of the problem this file is defending: "business
 * will have more messages by customers asking questions. but also customers
 * will be messaging multiple [businesses]. so we need to figure this out."
 *
 * Both lists were built for a handful of rows. Each took a limit, capped it at
 * two hundred, ordered by last_message_at and stopped -- so there was no way
 * to reach row 201 at all, no way to find one conversation among hundreds, and
 * an unanswered customer question sank one place for every OTHER conversation
 * that got a message until it was past the lid. None of that failed loudly.
 * The list simply ended.
 *
 * WHAT IS PINNED HERE, and every case failed before the change it guards:
 *
 *   A PAGE IS A STABLE PAGE. Two pages read through a cursor return every row
 *   exactly once -- no row repeated across the boundary and none skipped. That
 *   is the bug a keyset cursor exists to prevent and it is invisible unless
 *   you count.
 *
 *   AN UNANSWERED QUESTION IS AT THE TOP. Not "in the list": ahead of a more
 *   recent conversation that has already been read, which is the exact
 *   ordering an inbox needs and a log does not.
 *
 *   SEARCH FINDS BY NAME AND BY WHAT WAS SAID, AND NEVER CROSSES A BOUNDARY.
 *   There is no term anybody can type into either box that reaches another
 *   operator's conversation or another account's.
 *
 *   CLOSING WORKS ON BOTH SIDES AS DESIGNED. Off the operator's queue, still
 *   on the customer's account, labelled, and refusing new messages.
 *
 *   THE UNREAD COUNTS ARE RIGHT THROUGH BOTH CUSTOMER DOORS. A customer can
 *   reach a conversation by link or by account since migration 0052, and
 *   reading through either has to clear the same badge.
 */

const BASE = 'https://gap.test';
const OP = 'op-lists-a';
const OTHER = 'op-lists-b';

let env: Env;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function makeReq(method: string, path: string, opts: {
  body?: unknown; cookie?: string; ip?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = opts.cookie;
  headers['cf-connecting-ip'] = opts.ip ?? '203.0.113.11';
  return new Request(`${BASE}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const call = (method: string, path: string, opts: Parameters<typeof makeReq>[2] = {}) =>
  worker.fetch(makeReq(method, path, opts), env, ctx);

async function insertOperator(id: string, email: string, name: string) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,profile_slug,timezone,country,currency,
       language,location_mode,fill_model,sms_mode,plan,accept_public_bookings,is_published,
       created_at,updated_at)
     VALUES (?,?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       'active',1,1,?,?)`,
  ).bind(id, email, name, `${id}-slug`, t, t).run();
}

/** An operator with a session cookie, so the routes can be driven as one. */
async function operatorCookie(opId: string): Promise<string> {
  const raw = `sess-${opId}`;
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(`${raw}:${env.SESSION_PEPPER}`));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const t = now();
  await env.DB.prepare(
    `INSERT INTO sessions (id,operator_id,token_hash,expires_at,created_at)
     VALUES (?,?,?,?,?)`,
  ).bind(newId(), opId, hash, t + 86400, t).run();
  return `__Host-gf_session=${raw}`;
}

beforeEach(async () => {
  env = makeEnv(ALL_MIGRATIONS) as unknown as Env;
  await insertOperator(OP, 'a@x.com', 'Valley Detailing');
  await insertOperator(OTHER, 'b@x.com', 'Canyon Detailing');
});

/**
 * `n` conversations for one operator, spaced a minute apart and all read.
 *
 * SPACED, NOT ALL AT `now()`, because last_message_at has one-second
 * resolution: threads created in the same second land in an order the tie-break
 * decides rather than the one the test intends, and a paging test that cannot
 * say what order it expects is not testing paging. The spacing is written
 * directly because startThread stamps its own timestamp.
 *
 * MARKED READ, so these sit in the answered segment of the ordering and the
 * unread tests below can put exactly one row in the other one.
 */
async function seedThreads(operatorId: string, n: number, namePrefix = 'Cust') {
  const base = now();
  const made: Array<{ id: string; token: string; at: number }> = [];
  for (let i = 0; i < n; i += 1) {
    const { thread, token } = await startThread(env, {
      operator_id: operatorId,
      guest_name: `${namePrefix}${String(i).padStart(2, '0')}`,
      first_message: `Message number ${i}`,
    });
    const at = base - i * 60;
    await env.DB.prepare(
      `UPDATE threads SET last_message_at = ?, operator_unread = 0, guest_unread = 0
        WHERE id = ?`,
    ).bind(at, thread.id).run();
    made.push({ id: thread.id, token, at });
  }
  // Newest first, which is the order the list is expected to return them in.
  return made;
}

// ---------------------------------------------------------------------------
describe('paging the operator inbox', () => {
  it('returns a stable page and a cursor that reaches the rest exactly once', async () => {
    const made = await seedThreads(OP, 12);

    const first = await listThreads(env, OP, { limit: 5 });
    expect(first.threads).toHaveLength(5);
    expect(first.next_cursor).toEqual(expect.any(String));
    // The page is the top of the ordering, not an arbitrary five.
    expect(first.threads.map((t) => t.id)).toEqual(made.slice(0, 5).map((m) => m.id));

    const second = await listThreads(env, OP, { limit: 5, cursor: first.next_cursor });
    expect(second.threads.map((t) => t.id)).toEqual(made.slice(5, 10).map((m) => m.id));

    const third = await listThreads(env, OP, { limit: 5, cursor: second.next_cursor });
    expect(third.threads.map((t) => t.id)).toEqual(made.slice(10, 12).map((m) => m.id));
    // NULL IS THE END AND IS THE ONLY SIGNAL OF IT. A short page is not
    // enough on its own -- a page can be short and still have more behind it
    // once a filter is involved -- so the absence of a cursor is what the
    // front end is allowed to read as "that was all of them".
    expect(third.next_cursor).toBeNull();

    // EVERY ROW ONCE, WHICH IS THE WHOLE POINT. A boundary that repeated a row
    // would also have skipped one, and both are invisible without counting.
    const walked = [...first.threads, ...second.threads, ...third.threads].map((t) => t.id);
    expect(new Set(walked).size).toBe(12);
    expect([...walked].sort()).toEqual([...made.map((m) => m.id)].sort());
  });

  it('separates two conversations that share a second, and repeats neither', async () => {
    // THE CASE THE TIE-BREAK EXISTS FOR. last_message_at is whole seconds, so
    // an operator answering two people inside the same second gives two rows
    // one sort key. Without `id` in the cursor the boundary between them is
    // arbitrary: one comes back on both pages and the other on neither.
    const made = await seedThreads(OP, 4);
    const sameSecond = now() - 10_000;
    for (const m of made) {
      await env.DB.prepare(`UPDATE threads SET last_message_at = ? WHERE id = ?`)
        .bind(sameSecond, m.id).run();
    }

    const a = await listThreads(env, OP, { limit: 2 });
    const b = await listThreads(env, OP, { limit: 2, cursor: a.next_cursor });
    const walked = [...a.threads, ...b.threads].map((t) => t.id);
    expect(walked).toHaveLength(4);
    expect(new Set(walked).size).toBe(4);
  });

  it('is reachable past the old ceiling of two hundred rows', async () => {
    // WHAT THIS IS REALLY ASSERTING is that there is no lid. The old route
    // capped at two hundred with no cursor, so row 201 existed and could not
    // be read by anybody. Two hundred and one rows is slow to seed, so this
    // walks a small list to exhaustion instead and asserts the walk terminates
    // having seen everything -- which is the property the cap denied.
    const made = await seedThreads(OP, 9);
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page = await listThreads(env, OP, { limit: 2, cursor });
      seen.push(...page.threads.map((t) => t.id));
      cursor = page.next_cursor;
      guard += 1;
      expect(guard).toBeLessThan(20);   // a cursor that never ends is a loop
    } while (cursor);
    expect([...seen].sort()).toEqual([...made.map((m) => m.id)].sort());
  });
});

describe('an unanswered question in a busy inbox', () => {
  it('sorts ahead of more recent conversations that have been read', async () => {
    /*
      THE FAILURE THIS IS ABOUT, concretely. Ordered by recency alone, a
      question asked on Monday is below every conversation that got a message
      on Tuesday -- so the question that has been waiting longest, which is the
      one that loses the job, ends up furthest from the top and eventually on a
      page nobody opens.
    */
    const read = await seedThreads(OP, 4, 'Read');

    const { thread, token } = await startThread(env, {
      operator_id: OP, guest_name: 'Waiting', first_message: 'Does that include the arches?',
    });
    // Older than every one of the read rows, and unanswered.
    await env.DB.prepare(`UPDATE threads SET last_message_at = ? WHERE id = ?`)
      .bind(now() - 7 * 86400, thread.id).run();

    const page = await listThreads(env, OP, { limit: 10 });
    expect(page.threads[0]!.id).toBe(thread.id);
    expect(page.threads[0]!.guest_name).toBe('Waiting');
    // And the read ones still come after it in their own recency order, so
    // putting unread first has not scrambled the rest of the list.
    expect(page.threads.slice(1).map((t) => t.id)).toEqual(read.map((m) => m.id));

    // Once it is answered and read it takes its place by recency again -- the
    // reply bumps it to now(), so it is top for that reason instead.
    await postAsOperator(env, OP, thread.id, 'Yes, both.');
    await markThreadRead(env, 'operator', { operator_id: OP, thread_id: thread.id });
    const after = await listThreads(env, OP, { limit: 10 });
    expect(after.threads[0]!.id).toBe(thread.id);
    expect(after.threads[0]!.operator_unread).toBe(0);

    // A second unanswered question now outranks it despite being older.
    await postAsGuest(env, token, 'And the wheels?');
    await markThreadRead(env, 'operator', { operator_id: OP, thread_id: thread.id });
    const { thread: fresh } = await startThread(env, {
      operator_id: OP, guest_name: 'Newest', first_message: 'Tuesday?',
    });
    await env.DB.prepare(`UPDATE threads SET last_message_at = ? WHERE id = ?`)
      .bind(now() - 6 * 86400, fresh.id).run();
    const final = await listThreads(env, OP, { limit: 10 });
    expect(final.threads[0]!.id).toBe(fresh.id);
  });

  it('carries the unread rows across a page boundary without losing the read ones', async () => {
    // THE CURSOR HAS TO KNOW WHICH SEGMENT IT STOPPED IN. Three unread rows
    // and a page of two means the second page continues among the unread and
    // then crosses into the read ones; a cursor that forgot the segment would
    // either restart at the top of the unread ones or skip every read row more
    // recent than the last unread one.
    const read = await seedThreads(OP, 3, 'Read');
    const waiting: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { thread } = await startThread(env, {
        operator_id: OP, guest_name: `Wait${i}`, first_message: 'Hello?',
      });
      await env.DB.prepare(`UPDATE threads SET last_message_at = ? WHERE id = ?`)
        .bind(now() - (10 + i) * 86400, thread.id).run();
      waiting.push(thread.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    // GUARDED, and the guard is not decoration: a cursor that fails to advance
    // is an infinite loop rather than a wrong answer, so without this a
    // regression here hangs the suite instead of failing it. Found the hard
    // way while checking that these tests fail when the ordering is broken.
    let guard = 0;
    do {
      const page: Awaited<ReturnType<typeof listThreads>> =
        await listThreads(env, OP, { limit: 2, cursor });
      seen.push(...page.threads.map((t) => t.id));
      cursor = page.next_cursor;
      guard += 1;
      expect(guard).toBeLessThan(12);
    } while (cursor);

    // All three unread first, in their own order, then all three read ones.
    expect(seen).toEqual([...waiting, ...read.map((m) => m.id)]);
  });

  it('gives the unread filter its own page, and nothing else', async () => {
    await seedThreads(OP, 4, 'Read');
    const { thread } = await startThread(env, {
      operator_id: OP, guest_name: 'Waiting', first_message: 'Hello?',
    });
    const page = await listThreads(env, OP, { unreadOnly: true, limit: 10 });
    expect(page.threads.map((t) => t.id)).toEqual([thread.id]);
    expect(page.next_cursor).toBeNull();
  });
});

describe('finding one conversation', () => {
  it('matches the name, the subject and what was said', async () => {
    const { thread: byName } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosalind', subject: 'Full valet',
      first_message: 'Thursday afternoon if you can.',
    });
    const { thread: byBody } = await startThread(env, {
      operator_id: OP, guest_name: 'Dan', subject: 'Wash only',
      first_message: 'The alley behind the house is narrow.',
    });

    const name = await listThreads(env, OP, { q: 'rosal', status: 'all' });
    expect(name.threads.map((t) => t.id)).toEqual([byName.id]);

    const subject = await listThreads(env, OP, { q: 'valet', status: 'all' });
    expect(subject.threads.map((t) => t.id)).toEqual([byName.id]);

    // THE ONE THE OPERATOR ACTUALLY REMEMBERS. "The narrow alley" is often
    // the only thing they can recall about a conversation, and it is in the
    // messages rather than in any column on the thread.
    const body = await listThreads(env, OP, { q: 'narrow', status: 'all' });
    expect(body.threads.map((t) => t.id)).toEqual([byBody.id]);

    const nothing = await listThreads(env, OP, { q: 'helicopter', status: 'all' });
    expect(nothing.threads).toEqual([]);
    expect(nothing.next_cursor).toBeNull();
  });

  it('never reaches another operator conversation, by name or by message', async () => {
    /*
      THE PROPERTY THAT CANNOT BE COMPROMISED ON. The search adds a LIKE over
      guest_name, subject and chat_messages.body -- and the message match is a
      correlated EXISTS, which is the one place a badly written search could
      have escaped the tenant scope. There is no term that reaches the other
      business's row, because no row of theirs is ever a candidate.
    */
    const mine = await startThread(env, {
      operator_id: OP, guest_name: 'Rosalind', first_message: 'A narrow alley here.',
    });
    const theirs = await startThread(env, {
      operator_id: OTHER, guest_name: 'Rosalind', first_message: 'A narrow alley here.',
    });

    for (const q of ['rosal', 'narrow', 'alley', '%', '%%', '_', 'a']) {
      const page = await listThreads(env, OP, { q, status: 'all' });
      expect(page.threads.map((t) => t.id), q).not.toContain(theirs.thread.id);
    }

    // And the identical search from the other side finds theirs and not mine,
    // so the test cannot pass merely because one side returns nothing.
    const other = await listThreads(env, OTHER, { q: 'narrow', status: 'all' });
    expect(other.threads.map((t) => t.id)).toEqual([theirs.thread.id]);
    expect(other.threads.map((t) => t.id)).not.toContain(mine.thread.id);
  });

  it('treats a typed wildcard as a character and not as a wildcard', async () => {
    // Somebody typing a bare % used to get every row back, and a customer
    // called "Jo_" searched for "any three-letter name beginning Jo".
    const { thread: underscored } = await startThread(env, {
      operator_id: OP, guest_name: 'Jo_seph', first_message: 'Hi',
    });
    await startThread(env, { operator_id: OP, guest_name: 'Joseph', first_message: 'Hi' });

    const escaped = await listThreads(env, OP, { q: 'Jo_', status: 'all' });
    expect(escaped.threads.map((t) => t.id)).toEqual([underscored.id]);

    const everything = await listThreads(env, OP, { q: '%', status: 'all' });
    expect(everything.threads).toEqual([]);
  });

  it('filters to the conversations with a booking behind them', async () => {
    const { thread: enquiry } = await startThread(env, {
      operator_id: OP, guest_name: 'Asking', first_message: 'How much?',
    });
    const { thread: booked } = await startThread(env, {
      operator_id: OP, guest_name: 'Booked', first_message: 'See you Tuesday',
      appointment_id: 'appt-1',
    });

    const page = await listThreads(env, OP, { bookedOnly: true, status: 'all' });
    expect(page.threads.map((t) => t.id)).toEqual([booked.id]);
    expect(page.threads.map((t) => t.id)).not.toContain(enquiry.id);
  });
});

describe('one operator inbox never shows another one a row', () => {
  it('keeps the lists apart under every filter and every page', async () => {
    const mine = await seedThreads(OP, 3, 'Mine');
    const theirs = await seedThreads(OTHER, 3, 'Theirs');

    for (const opts of [
      {}, { unreadOnly: true }, { bookedOnly: true }, { status: 'closed' as const },
      { status: 'all' as const }, { q: 'Theirs', status: 'all' as const },
      { limit: 1 }, { limit: 1, status: 'all' as const },
    ]) {
      const page = await listThreads(env, OP, opts);
      for (const row of page.threads) {
        expect(row.operator_id).toBe(OP);
        expect(theirs.map((t) => t.id)).not.toContain(row.id);
      }
    }

    // The mirror image, so this cannot pass because one side is empty.
    const back = await listThreads(env, OTHER, { status: 'all' });
    expect(back.threads.map((t) => t.id).sort()).toEqual(theirs.map((t) => t.id).sort());
    for (const row of back.threads) expect(mine.map((t) => t.id)).not.toContain(row.id);
  });

  it('answers a blank operator id with nothing rather than with everything', async () => {
    // A missing tenant must never be read as "no filter". This is the shape of
    // bug that turns a list into a dump of the whole table.
    await seedThreads(OP, 2);
    const page = await listThreads(env, '', { status: 'all' });
    expect(page.threads).toEqual([]);
    expect(page.next_cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('closing a conversation', () => {
  it('takes it off the operator queue, clears their badge, and refuses messages', async () => {
    const { thread, token } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa', first_message: 'All done?',
    });
    expect((await listThreads(env, OP)).threads.map((t) => t.id)).toEqual([thread.id]);

    const closed = await setThreadStatus(env, OP, thread.id, 'closed');
    expect(closed.status).toBe('closed');
    // THE BADGE GOES WITH IT. Left behind it would be a number over a list
    // that does not contain the row, for ever, with nothing to press.
    expect(closed.operator_unread).toBe(0);

    const open = await listThreads(env, OP);
    expect(open.threads).toEqual([]);

    const archive = await listThreads(env, OP, { status: 'closed' });
    expect(archive.threads.map((t) => t.id)).toEqual([thread.id]);

    // Still refuses new messages from either side, which is what the column
    // has always meant -- there was simply never a way to set it.
    await expect(postAsGuest(env, token, 'One more thing')).rejects.toThrow(/closed/i);
    await expect(postAsOperator(env, OP, thread.id, 'Anything else?')).rejects.toThrow(/closed/i);
  });

  it('leaves the customer unread count alone, because it is not the business to clear', async () => {
    const { thread } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa', first_message: 'All done?',
    });
    // The business has the last word and then closes the conversation. That
    // last word is exactly the message the customer most needs to be told
    // arrived, so closing must not mark it read on their behalf.
    await postAsOperator(env, OP, thread.id, 'We cannot do Tuesday after all.');
    const before = await env.DB.prepare(`SELECT guest_unread FROM threads WHERE id = ?`)
      .bind(thread.id).first<{ guest_unread: number }>();
    expect(before!.guest_unread).toBe(1);

    await setThreadStatus(env, OP, thread.id, 'closed');
    const after = await env.DB.prepare(`SELECT guest_unread FROM threads WHERE id = ?`)
      .bind(thread.id).first<{ guest_unread: number }>();
    expect(after!.guest_unread).toBe(1);
  });

  it('reopens without inventing a badge that was already read', async () => {
    const { thread, token } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa', first_message: 'Still there?',
    });
    await setThreadStatus(env, OP, thread.id, 'closed');
    const reopened = await setThreadStatus(env, OP, thread.id, 'open');
    expect(reopened.status).toBe('open');
    expect(reopened.operator_unread).toBe(0);
    expect((await listThreads(env, OP)).threads.map((t) => t.id)).toEqual([thread.id]);
    // And it takes messages again.
    await expect(postAsGuest(env, token, 'Yes, thanks')).resolves.toBeTruthy();
  });

  it('refuses to close another operator conversation, in the same words a fake id gets', async () => {
    const { thread } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa', first_message: 'Hi',
    });
    await expect(setThreadStatus(env, OTHER, thread.id, 'closed'))
      .rejects.toThrow(/not yours/i);
    await expect(setThreadStatus(env, OTHER, 'no-such-thread', 'closed'))
      .rejects.toThrow(/not yours/i);
    // And nothing moved.
    const row = await env.DB.prepare(`SELECT status FROM threads WHERE id = ?`)
      .bind(thread.id).first<{ status: string }>();
    expect(row!.status).toBe('open');
  });

  it('is driven through the route with an operator session, and only that operator', async () => {
    const mineCookie = await operatorCookie(OP);
    const theirsCookie = await operatorCookie(OTHER);
    const { thread } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa', first_message: 'Hi',
    });

    const wrong = await call('POST', `/api/threads/${thread.id}/status`,
      { cookie: theirsCookie, body: {} });
    expect(wrong.status).toBe(404);

    const signedOut = await call('POST', `/api/threads/${thread.id}/status`, { body: {} });
    expect(signedOut.status).toBe(401);

    const ok = await call('POST', `/api/threads/${thread.id}/status`,
      { cookie: mineCookie, body: {} });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { thread: { status: string } }).thread.status).toBe('closed');

    const back = await call('POST', `/api/threads/${thread.id}/status`,
      { cookie: mineCookie, body: { open: true } });
    expect((await back.json() as { thread: { status: string } }).thread.status).toBe('open');
  });

  it('lets the route page, filter and search the inbox', async () => {
    const cookie = await operatorCookie(OP);
    const made = await seedThreads(OP, 6);

    const first = await call('GET', '/api/threads?limit=2', { cookie });
    const a = await first.json() as {
      threads: Array<{ id: string }>; next_cursor: string | null; unread: number;
    };
    expect(a.threads).toHaveLength(2);
    expect(a.next_cursor).toEqual(expect.any(String));

    const second = await call(
      'GET', `/api/threads?limit=2&cursor=${encodeURIComponent(a.next_cursor!)}`, { cookie });
    const b = await second.json() as { threads: Array<{ id: string }> };
    expect(b.threads.map((t) => t.id)).toEqual(made.slice(2, 4).map((m) => m.id));

    const found = await call('GET', '/api/threads?q=Cust04&status=all', { cookie });
    const c = await found.json() as { threads: Array<{ guest_name: string }> };
    expect(c.threads.map((t) => t.guest_name)).toEqual(['Cust04']);
  });

  it('draws a nonsense cursor as the first page rather than as an error', async () => {
    // A cursor arrives from a URL somebody may have edited or kept from an
    // older payload. The honest answer to a value that means nothing is the
    // top of the list, which is what pressing reload would have given them.
    const made = await seedThreads(OP, 3);
    for (const cursor of ['', 'nonsense', '1.2', '2.5.x', 'x.y.z', '1.notanumber.abc']) {
      const page = await listThreads(env, OP, { limit: 2, cursor });
      expect(page.threads.map((t) => t.id), cursor).toEqual(made.slice(0, 2).map((m) => m.id));
    }
  });
});

// ---------------------------------------------------------------------------
// The customer's side
// ---------------------------------------------------------------------------

/** A conversation on this account with this business, at a chosen moment. */
async function threadFor(accountId: string, operatorId: string, opts: {
  name: string; at: number; unread?: number; status?: 'open' | 'closed';
  first?: string; subject?: string | null;
}) {
  const { thread, token } = await startThread(env, {
    operator_id: operatorId,
    customer_account_id: accountId,
    guest_name: opts.name,
    subject: opts.subject ?? null,
    first_message: opts.first ?? 'Hello there',
  });
  await env.DB.prepare(
    `UPDATE threads SET last_message_at = ?, guest_unread = ?, operator_unread = 0,
            status = ? WHERE id = ?`,
  ).bind(opts.at, opts.unread ?? 0, opts.status ?? 'open', thread.id).run();
  return { id: thread.id, token };
}

describe('a customer with several businesses', () => {
  it('pages their list and reaches every conversation exactly once', async () => {
    const me = await signInCustomer(env, 'rosa@mailbox.test', { phone: '+18185550142' });
    const base = now();
    const made: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const t = await threadFor(me.accountId, i % 2 ? OTHER : OP,
        { name: 'Rosa', at: base - i * 60 });
      made.push(t.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    // See the guard in the operator's own walk: a cursor that does not advance
    // hangs the suite rather than failing it, which is a worse way to find out.
    let guard = 0;
    do {
      const page: Awaited<ReturnType<typeof listThreadsForCustomer>> =
        await listThreadsForCustomer(env, me.accountId, { limit: 3, cursor });
      seen.push(...page.threads.map((t) => t.id));
      cursor = page.next_cursor;
      guard += 1;
      expect(guard).toBeLessThan(12);
    } while (cursor);

    expect(seen).toEqual(made);
    expect(new Set(seen).size).toBe(7);
  });

  it('puts a business that has replied above one that has not', async () => {
    // THE QUESTION THIS LIST IS OPENED WITH: which of the five trades I have
    // had out has answered me. Ordered by recency alone the answer is buried
    // under whichever conversation happened to move last.
    const me = await signInCustomer(env, 'rosa@mailbox.test', { phone: '+18185550142' });
    const quiet = await threadFor(me.accountId, OP, { name: 'Rosa', at: now() - 60 });
    const replied = await threadFor(me.accountId, OTHER,
      { name: 'Rosa', at: now() - 9 * 86400, unread: 2 });

    const page = await listThreadsForCustomer(env, me.accountId, { limit: 10 });
    expect(page.threads.map((t) => t.id)).toEqual([replied.id, quiet.id]);
    expect(page.threads[0]!.guest_unread).toBe(2);
    expect(await unreadThreadCountForCustomer(env, me.accountId)).toBe(1);
  });

  it('narrows to one business, and to the unread ones', async () => {
    const me = await signInCustomer(env, 'rosa@mailbox.test', { phone: '+18185550142' });
    const valley = await threadFor(me.accountId, OP, { name: 'Rosa', at: now() - 60 });
    const canyon = await threadFor(me.accountId, OTHER,
      { name: 'Rosa', at: now() - 120, unread: 1 });

    const one = await listThreadsForCustomer(env, me.accountId, { operatorId: OP });
    expect(one.threads.map((t) => t.id)).toEqual([valley.id]);

    const waiting = await listThreadsForCustomer(env, me.accountId, { unreadOnly: true });
    expect(waiting.threads.map((t) => t.id)).toEqual([canyon.id]);

    // The filter is drawn from a query of its own, so it can offer a business
    // whose conversation is not on the current page.
    const res = await call('GET', '/api/customer/threads?limit=1', { cookie: me.cookie });
    const body = await res.json() as {
      threads: Array<{ id: string }>; next_cursor: string | null; unread: number;
      businesses: Array<{ operator_id: string; business_name: string; threads: number }>;
    };
    expect(body.threads).toHaveLength(1);
    expect(body.next_cursor).toEqual(expect.any(String));
    expect(body.unread).toBe(1);
    expect(body.businesses.map((b) => b.operator_id).sort()).toEqual([OP, OTHER].sort());
    expect(body.businesses.find((b) => b.operator_id === OP)!.business_name)
      .toBe('Valley Detailing');
  });

  it('searches the business name and what was said, and nothing else account', async () => {
    const me = await signInCustomer(env, 'rosa@mailbox.test', { phone: '+18185550142' });
    const them = await signInCustomer(env, 'someone.else@mailbox.test',
      { phone: '+18185550143' });

    const mine = await threadFor(me.accountId, OP,
      { name: 'Rosa', at: now() - 60, first: 'The gate sticks in the rain.' });
    const theirs = await threadFor(them.accountId, OP,
      { name: 'Sam', at: now() - 30, first: 'The gate sticks in the rain.' });

    // THE OTHER SIDE'S NAME IS THE BUSINESS, not their own first name --
    // theirs is on every row on this screen and tells nothing apart.
    const byBusiness = await listThreadsForCustomer(env, me.accountId, { q: 'valley' });
    expect(byBusiness.threads.map((t) => t.id)).toEqual([mine.id]);

    const byBody = await listThreadsForCustomer(env, me.accountId, { q: 'gate sticks' });
    expect(byBody.threads.map((t) => t.id)).toEqual([mine.id]);

    // NOT ACROSS ACCOUNTS, under any term. Both conversations are with the
    // same business and contain the same sentence, which is the case that
    // would catch a search bolted on outside the account scope.
    for (const q of ['valley', 'gate', 'rain', 'sam', '%', '_', 'a']) {
      const page = await listThreadsForCustomer(env, me.accountId, { q });
      expect(page.threads.map((t) => t.id), q).not.toContain(theirs.id);
    }

    // And from the other account, the mirror image.
    const other = await listThreadsForCustomer(env, them.accountId, { q: 'gate' });
    expect(other.threads.map((t) => t.id)).toEqual([theirs.id]);
  });

  it('never returns another account row under any filter, page or search', async () => {
    const me = await signInCustomer(env, 'rosa@mailbox.test', { phone: '+18185550142' });
    const them = await signInCustomer(env, 'someone.else@mailbox.test',
      { phone: '+18185550143' });

    const theirs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      theirs.push((await threadFor(them.accountId, OP,
        { name: 'Sam', at: now() - i * 60, unread: 1 })).id);
    }
    await threadFor(me.accountId, OP, { name: 'Rosa', at: now() - 500 });

    for (const opts of [
      {}, { unreadOnly: true }, { status: 'all' as const }, { status: 'closed' as const },
      { operatorId: OP }, { q: 'Sam' }, { q: 'valley' }, { limit: 1 },
    ]) {
      const page = await listThreadsForCustomer(env, me.accountId, opts);
      for (const row of page.threads) {
        expect(theirs, JSON.stringify(opts)).not.toContain(row.id);
      }
    }

    // A blank account id is not "no filter".
    expect((await listThreadsForCustomer(env, '', { status: 'all' })).threads).toEqual([]);
  });

  it('keeps a closed conversation on the list and says who closed it', async () => {
    /*
      THE ASYMMETRY THAT IS THE POINT. The operator's inbox hides closed
      conversations, because closing is how a business gets a finished job off
      its screen. Doing the same here would mean a business closing a
      conversation made it VANISH off the customer's account -- the messages
      agreeing what the work was, the photographs, the price they paid --
      without anybody telling them and without them doing anything.
    */
    const me = await signInCustomer(env, 'rosa@mailbox.test', { phone: '+18185550142' });
    const t = await threadFor(me.accountId, OP, { name: 'Rosa', at: now() - 60 });
    await setThreadStatus(env, OP, t.id, 'closed');

    // Gone from the business's default queue.
    expect((await listThreads(env, OP)).threads.map((r) => r.id)).not.toContain(t.id);

    // Still on the customer's, by default, with the status on the row so the
    // page can say so rather than pretending it is live.
    const page = await listThreadsForCustomer(env, me.accountId);
    expect(page.threads.map((r) => r.id)).toEqual([t.id]);
    expect(page.threads[0]!.status).toBe('closed');

    // And the route agrees, which is what /account actually reads.
    const res = await call('GET', '/api/customer/threads', { cookie: me.cookie });
    const body = await res.json() as { threads: Array<{ id: string; status: string }> };
    expect(body.threads.map((r) => r.id)).toEqual([t.id]);
    expect(body.threads[0]!.status).toBe('closed');

    // A reader who wants only the live ones can still ask.
    const openOnly = await listThreadsForCustomer(env, me.accountId, { status: 'open' });
    expect(openOnly.threads).toEqual([]);

    // It still opens and still reads, on the account's own authority.
    const read = await call('GET', `/api/public/threads/${t.id}`, { cookie: me.cookie });
    expect(read.status).toBe(200);
  });
});

describe('the customer unread badge, through both doors', () => {
  it('is cleared by reading on the link and by reading on the account', async () => {
    /*
      A CUSTOMER HAS TWO WAYS IN SINCE MIGRATION 0052 and one badge. Both doors
      arrive at the same route, which calls markThreadRead with whatever the
      router resolved -- a raw token on one, an already-authorised Thread on
      the other. If that had taken a string, the account door's object would
      have missed the lookup, the early return would have swallowed it, and
      somebody who read every message on their account would have kept the
      badge for ever with no way to clear it except finding the link they came
      here because they had lost.
    */
    const me = await signInCustomer(env, 'rosa@mailbox.test', { phone: '+18185550142' });

    const viaLink = await threadFor(me.accountId, OP, { name: 'Rosa', at: now() - 60 });
    await postAsOperator(env, OP, viaLink.id, 'We are on our way.');
    expect(await unreadThreadCountForCustomer(env, me.accountId)).toBe(1);

    const link = await call('GET', `/api/public/threads/${viaLink.token}`);
    expect(link.status).toBe(200);
    expect(await unreadThreadCountForCustomer(env, me.accountId)).toBe(0);

    const viaAccount = await threadFor(me.accountId, OTHER, { name: 'Rosa', at: now() - 30 });
    await postAsOperator(env, OTHER, viaAccount.id, 'Tuesday works.');
    expect(await unreadThreadCountForCustomer(env, me.accountId)).toBe(1);

    // THE ACCOUNT DOOR: a thread id, a session cookie, no token anywhere.
    const acct = await call('GET', `/api/public/threads/${viaAccount.id}`,
      { cookie: me.cookie, ip: '198.51.100.21' });
    expect(acct.status).toBe(200);
    expect(await unreadThreadCountForCustomer(env, me.accountId)).toBe(0);

    // And the rows agree, not just the total.
    const rows = await listThreadsForCustomer(env, me.accountId, { status: 'all' });
    for (const row of rows.threads) expect(row.guest_unread).toBe(0);
  });

  it('does not let one account clear another badge through the account door', async () => {
    const me = await signInCustomer(env, 'rosa@mailbox.test', { phone: '+18185550142' });
    const them = await signInCustomer(env, 'someone.else@mailbox.test',
      { phone: '+18185550143' });

    const theirs = await threadFor(them.accountId, OP, { name: 'Sam', at: now() - 60 });
    await postAsOperator(env, OP, theirs.id, 'On our way.');
    expect(await unreadThreadCountForCustomer(env, them.accountId)).toBe(1);

    const res = await call('GET', `/api/public/threads/${theirs.id}`,
      { cookie: me.cookie, ip: '198.51.100.22' });
    expect(res.status).toBe(404);
    // The refusal changed nothing: a 404 that still cleared the badge would be
    // a way to mark a stranger's messages read.
    expect(await unreadThreadCountForCustomer(env, them.accountId)).toBe(1);
  });

  it('counts conversations and not messages, and counts closed ones too', async () => {
    const me = await signInCustomer(env, 'rosa@mailbox.test', { phone: '+18185550142' });
    const t = await threadFor(me.accountId, OP, { name: 'Rosa', at: now() - 60 });
    await postAsOperator(env, OP, t.id, 'One.');
    await postAsOperator(env, OP, t.id, 'Two.');
    // Two messages, one conversation waiting. The badge over a list of
    // conversations has to be a count of rows or it reads as the wrong number.
    expect(await unreadThreadCountForCustomer(env, me.accountId)).toBe(1);

    // Closed by the business, and the badge stays: their last word before
    // closing is exactly what the customer needs to be told arrived.
    await setThreadStatus(env, OP, t.id, 'closed');
    expect(await unreadThreadCountForCustomer(env, me.accountId)).toBe(1);
  });
});
