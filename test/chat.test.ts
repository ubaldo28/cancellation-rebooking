import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import {
  attachBooking, listMessages, listThreads, markThreadRead, postAsGuest, postAsOperator,
  startThread, threadByToken, threadForOperator, unreadThreadCount, MAX_MESSAGE_CHARS,
} from '../src/lib/chat';
import { newId, now } from '../src/lib/util';

const MIGRATIONS = ALL_MIGRATIONS;

let env: Env;

// Two businesses. The second one exists purely so the tenant boundary has
// something to be tested against.
const OP = 'op1';
const OTHER = 'op2';

async function insertOperator(id: string, email: string, name: string) {
  const n = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,timezone,country,currency,language,
       location_mode,fill_model,sms_mode,max_detour_seconds,min_gap_seconds,buffer_seconds,
       offer_ttl_seconds,offers_per_wave,min_notice_seconds,reoffer_cooldown_seconds,
       discount_percent,plan,accept_public_bookings,deposit_cents,created_at,updated_at)
     VALUES (?,?,?, 'America/Los_Angeles','US','USD','en','mobile','both','device',
       900,3600,900,5400,3,3600,604800,0,'active',1,1000,?,?)`,
  ).bind(id, email, name, n, n).run();
}

beforeEach(async () => {
  env = makeEnv(MIGRATIONS) as unknown as Env;
  await insertOperator(OP, 'a@x.com', 'Valley Detailing');
  await insertOperator(OTHER, 'b@x.com', 'Canyon Detailing');
});

describe('a question before there is a booking', () => {
  it('starts a thread with no appointment and lets the guest talk', async () => {
    const gapId = newId();
    const { thread, token } = await startThread(env, {
      operator_id: OP,
      gap_id: gapId,
      guest_name: 'Rosa',
      subject: 'Thursday morning',
      first_message: 'Does that price include the inside of the windows?',
    });

    // The whole point: the conversation exists before the booking does.
    expect(thread.appointment_id).toBeNull();
    expect(thread.client_id).toBeNull();
    expect(thread.gap_id).toBe(gapId);
    expect(thread.status).toBe('open');

    await postAsGuest(env, token, 'And the wheel arches?');

    const messages = await listMessages(env, thread.id);
    expect(messages.map((m) => m.sender)).toEqual(['guest', 'guest']);
    expect(messages[0]!.body).toMatch(/inside of the windows/);
    expect(messages[1]!.body).toBe('And the wheel arches?');
  });

  it('never stores the raw token, only its hash', async () => {
    const { thread, token } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa',
    });
    const row = await env.DB.prepare(
      `SELECT guest_token_hash FROM threads WHERE id = ?`,
    ).bind(thread.id).first<{ guest_token_hash: string }>();

    expect(row!.guest_token_hash).not.toBe(token);
    expect(row!.guest_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the secret link is the customer identity', () => {
  it('resolves the thread from the raw token', async () => {
    const { thread, token } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa',
    });
    const found = await threadByToken(env, token);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(thread.id);
    expect(found!.guest_name).toBe('Rosa');
  });

  it('resolves nothing for a token that was never issued', async () => {
    await startThread(env, { operator_id: OP, guest_name: 'Rosa' });
    expect(await threadByToken(env, 'not-a-real-token')).toBeNull();
    expect(await threadByToken(env, '')).toBeNull();
  });

  it('refuses a message on a link that resolves to nothing', async () => {
    await expect(postAsGuest(env, 'not-a-real-token', 'hello'))
      .rejects.toThrow(/not valid/i);
  });
});

describe('one business cannot reach another business conversation', () => {
  it('does not hand the thread to the wrong operator', async () => {
    const { thread } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa', first_message: 'Thursday?',
    });

    expect((await threadForOperator(env, OP, thread.id))!.id).toBe(thread.id);
    expect(await threadForOperator(env, OTHER, thread.id)).toBeNull();
  });

  it('does not let the wrong operator post into it', async () => {
    const { thread } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa', first_message: 'Thursday?',
    });

    await expect(postAsOperator(env, OTHER, thread.id, 'We can do 9am.'))
      .rejects.toThrow(/not yours/i);

    // And nothing landed: no message, and the guest badge never moved.
    const messages = await listMessages(env, thread.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.sender).toBe('guest');
    const after = await threadForOperator(env, OP, thread.id);
    expect(after!.guest_unread).toBe(0);
  });

  it('keeps the two inboxes separate', async () => {
    await startThread(env, { operator_id: OP, guest_name: 'Rosa', first_message: 'Hi' });
    await startThread(env, { operator_id: OTHER, guest_name: 'Dan', first_message: 'Hi' });

    expect(await listThreads(env, OP)).toHaveLength(1);
    expect((await listThreads(env, OP))[0]!.guest_name).toBe('Rosa');
    expect(await unreadThreadCount(env, OP)).toBe(1);
    expect(await unreadThreadCount(env, OTHER)).toBe(1);
  });

  it('does not let the wrong operator clear somebody else badge', async () => {
    const { thread } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa', first_message: 'Thursday?',
    });

    await markThreadRead(env, 'operator', { operator_id: OTHER, thread_id: thread.id });
    expect(await unreadThreadCount(env, OP)).toBe(1);
  });
});

describe('unread counters', () => {
  it('increments the other side and clears on read', async () => {
    const { thread, token } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa', first_message: 'Does it include the windows?',
    });

    // The guest spoke, so the operator is the one with something to read.
    let t = await threadForOperator(env, OP, thread.id);
    expect(t!.operator_unread).toBe(1);
    expect(t!.guest_unread).toBe(0);

    await postAsGuest(env, token, 'And the arches?');
    t = await threadForOperator(env, OP, thread.id);
    expect(t!.operator_unread).toBe(2);
    expect(t!.guest_unread).toBe(0);

    await markThreadRead(env, 'operator', { operator_id: OP, thread_id: thread.id });
    t = await threadForOperator(env, OP, thread.id);
    expect(t!.operator_unread).toBe(0);
    expect(await unreadThreadCount(env, OP)).toBe(0);

    // Now the operator answers and the badge moves to the customer.
    await postAsOperator(env, OP, thread.id, 'Yes, both.');
    t = await threadForOperator(env, OP, thread.id);
    expect(t!.guest_unread).toBe(1);
    expect(t!.operator_unread).toBe(0);

    await markThreadRead(env, 'guest', { token });
    expect((await threadByToken(env, token))!.guest_unread).toBe(0);
  });

  it('moves the thread up the inbox on every message', async () => {
    const first = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa', first_message: 'Hi',
    });
    const second = await startThread(env, {
      operator_id: OP, guest_name: 'Dan', first_message: 'Hi',
    });

    // Nudge the older thread ahead of the newer one and post into it.
    await env.DB.prepare(`UPDATE threads SET last_message_at = ? WHERE id = ?`)
      .bind(now() - 3600, first.thread.id).run();
    await env.DB.prepare(`UPDATE threads SET last_message_at = ? WHERE id = ?`)
      .bind(now() - 60, second.thread.id).run();

    await postAsGuest(env, first.token, 'Still there?');
    expect((await listThreads(env, OP))[0]!.id).toBe(first.thread.id);

    expect(await listThreads(env, OP, { unreadOnly: true })).toHaveLength(2);
    await markThreadRead(env, 'operator', { operator_id: OP, thread_id: second.thread.id });
    expect(await listThreads(env, OP, { unreadOnly: true })).toHaveLength(1);
  });
});

describe('what a message is allowed to be', () => {
  it('refuses an empty or whitespace-only message', async () => {
    const { thread, token } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa',
    });
    await expect(postAsGuest(env, token, '')).rejects.toThrow(/type a message/i);
    await expect(postAsGuest(env, token, '   \n\t ')).rejects.toThrow(/type a message/i);
    await expect(postAsOperator(env, OP, thread.id, '  ')).rejects.toThrow(/type a message/i);
    expect(await listMessages(env, thread.id)).toHaveLength(0);
  });

  it('refuses a message past the length cap and keeps one just under it', async () => {
    const { thread, token } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa',
    });
    await expect(postAsGuest(env, token, 'x'.repeat(MAX_MESSAGE_CHARS + 1)))
      .rejects.toThrow(/too long/i);
    await expect(postAsOperator(env, OP, thread.id, 'x'.repeat(MAX_MESSAGE_CHARS + 1)))
      .rejects.toThrow(/too long/i);

    await postAsGuest(env, token, 'x'.repeat(MAX_MESSAGE_CHARS));
    expect(await listMessages(env, thread.id)).toHaveLength(1);
  });
});

describe('a closed conversation', () => {
  it('still reads, but takes nothing new from either side', async () => {
    const { thread, token } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa', first_message: 'Thursday?',
    });
    await env.DB.prepare(`UPDATE threads SET status = 'closed' WHERE id = ?`)
      .bind(thread.id).run();

    await expect(postAsGuest(env, token, 'One more thing'))
      .rejects.toThrow(/closed/i);
    await expect(postAsOperator(env, OP, thread.id, 'One more thing'))
      .rejects.toThrow(/closed/i);

    expect(await listMessages(env, thread.id)).toHaveLength(1);
  });
});

describe('the guest rate limit', () => {
  it('trips once one thread has burned through the window', async () => {
    const { thread, token } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa',
    });

    for (let i = 0; i < 20; i++) await postAsGuest(env, token, `message ${i}`);
    await expect(postAsGuest(env, token, 'and another'))
      .rejects.toThrow(/few minutes/i);

    expect(await listMessages(env, thread.id, 500)).toHaveLength(20);

    // The operator is not caught by it -- they are behind a session, and the
    // limit exists because the guest endpoint is not.
    await postAsOperator(env, OP, thread.id, 'Slow down, Rosa.');
    expect(await listMessages(env, thread.id, 500)).toHaveLength(21);
  });

  it('lets the guest talk again once the old messages age out of the window', async () => {
    const { thread, token } = await startThread(env, {
      operator_id: OP, guest_name: 'Rosa',
    });
    for (let i = 0; i < 20; i++) await postAsGuest(env, token, `message ${i}`);

    // Six minutes ago: outside the five-minute window.
    await env.DB.prepare(`UPDATE chat_messages SET created_at = ? WHERE thread_id = ?`)
      .bind(now() - 360, thread.id).run();

    await postAsGuest(env, token, 'still here');
    expect(await listMessages(env, thread.id, 500)).toHaveLength(21);
  });
});

describe('the booking that comes out of the conversation', () => {
  it('links a pre-booking thread to the appointment it produced', async () => {
    const gapId = newId();
    const { thread, token } = await startThread(env, {
      operator_id: OP, gap_id: gapId, guest_name: 'Rosa',
      first_message: 'Does that price include the inside of the windows?',
    });
    expect(thread.appointment_id).toBeNull();

    const appointmentId = newId();
    const clientId = newId();
    await attachBooking(env, thread.id, {
      appointment_id: appointmentId, client_id: clientId,
    });

    const linked = await threadForOperator(env, OP, thread.id);
    expect(linked!.appointment_id).toBe(appointmentId);
    expect(linked!.client_id).toBe(clientId);
    expect(linked!.gap_id).toBe(gapId);

    // The same link keeps working after the booking -- that is where "I'll
    // leave the gate unlocked" arrives.
    await postAsGuest(env, token, "I'll leave the gate unlocked.");
    const messages = await listMessages(env, thread.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.body).toMatch(/gate unlocked/);
  });

  it('refuses to attach a booking to a conversation that does not exist', async () => {
    await expect(attachBooking(env, 'no-such-thread', { appointment_id: newId() }))
      .rejects.toThrow(/no such conversation/i);
  });
});
