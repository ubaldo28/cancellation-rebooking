import type { Candidate, Env, Operator } from './types';
import {
  clearCookie, consumeLoginToken, createLoginToken, requireOperator, revokeSession,
} from './lib/auth';
import {
  COUNTRY_LIST, formatMoney, getCountry, isValidPostcode, localeFor,
} from './lib/countries';
import { preflight, withCors } from './lib/cors';
import { mayEchoSignInLink, sendEmail, signInEmail } from './lib/email';
import { detectGaps } from './lib/gaps';
import { geocode } from './lib/geo';
import { clientIp, enforceRateLimit } from './lib/ratelimit';
import { START_WORDS, STOP_WORDS, copy, isLang, pickLang } from './lib/messages';
import { verifyTwilioSignature } from './lib/twilio';
import {
  acceptOffer, createOffers, declineOffer, loadOfferByToken, markViewed,
} from './lib/offers';
import { rankCandidates, type GapRow } from './lib/rank';
import { addLocalDays, formatTimeRange, localDayStart } from './lib/tz';
import {
  HttpError, badRequest, escapeHtml, html, json, newId, notFound, now, toE164,
} from './lib/util';

// ---------------------------------------------------------------------------
// Tiny router
// ---------------------------------------------------------------------------
type Handler = (ctx: {
  req: Request; env: Env; params: Record<string, string>; url: URL;
}) => Promise<Response>;

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:[A-Za-z_]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '/?$',
  );
  routes.push({ method, pattern, keys, handler });
}

async function body<T = any>(req: Request): Promise<T> {
  const ct = req.headers.get('content-type') ?? '';
  try {
    if (ct.includes('application/json')) return (await req.json()) as T;
    if (ct.includes('form')) return Object.fromEntries(await req.formData()) as T;
  } catch { /* fall through */ }
  return {} as T;
}

/**
 * Mark an operator's calendar as moved.
 *
 * The cron uses this to decide who actually needs rescanning. Anything that
 * can change where a gap starts or ends must call it: bookings, completions,
 * cancellations, working hours, time off. Missing a call means stale gaps;
 * calling it too often just costs one cheap write.
 */
const touchCalendar = (env: Env, operatorId: string) =>
  env.DB.prepare(
    `UPDATE operators SET calendar_version = calendar_version + 1, updated_at = ? WHERE id = ?`,
  ).bind(now(), operatorId).run();

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
const int = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
route('POST', '/api/auth/request', async ({ req, env }) => {
  const b = await body(req);
  const email = str(b.email)?.toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter a valid email.');

  // Two buckets: one stops someone hammering a single mailbox, the other stops
  // one host mass-creating operator rows.
  await enforceRateLimit(env, `auth:${email}`, 5, 900);
  await enforceRateLimit(env, `auth-ip:${clientIp(req)}`, 20, 900);

  let op = await env.DB.prepare(`SELECT * FROM operators WHERE lower(email) = ?`)
    .bind(email).first<Operator>();

  if (!op) {
    const t = now();
    const id = newId();
    // Country drives the sensible defaults for timezone and currency, but the
    // caller can override both — and MUST, in a multi-timezone country.
    const iso = (str(b.country) ?? 'GB').toUpperCase();
    const c = getCountry(iso);
    if (!c) throw badRequest(`Country "${iso}" is not supported yet.`, 'unsupported_country');

    await env.DB.prepare(
      `INSERT INTO operators (id, email, business_name, trade, timezone, country, currency,
                              location_mode, fill_model, trial_ends_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, email, str(b.business_name) ?? 'My business', str(b.trade),
      str(b.timezone) ?? c.defaultTimezone, c.iso2, str(b.currency) ?? c.currency,
      str(b.location_mode) ?? 'mobile', str(b.fill_model) ?? 'both',
      t + 60 * 60 * 24 * 14, t, t,
    ).run();
    op = await env.DB.prepare(`SELECT * FROM operators WHERE id = ?`).bind(id).first<Operator>();
  }

  const token = await createLoginToken(env, op!.id);
  const link = `${env.APP_URL.replace(/\/$/, '')}/auth/verify?token=${token}`;

  const mail = signInEmail(link, op!.business_name);
  mail.to = op!.email;
  const result = await sendEmail(env, mail);

  // The link is echoed ONLY for local development, and only to a caller that
  // presented the debug secret. Anything else gets the same opaque response
  // whether or not the address exists, so this endpoint cannot be used to
  // enumerate operators — or, as it previously could, to sign in as one.
  if (mayEchoSignInLink(env, req.headers.get('x-auth-debug'))) {
    return json({ ok: true, sign_in_link: link, email: result });
  }

  if (!result.sent) {
    console.error('sign-in email not sent', result);
    if (result.reason === 'not_configured') {
      throw new HttpError(
        503,
        'Email delivery is not configured, so sign-in links cannot be sent.',
        'email_not_configured',
      );
    }
    throw new HttpError(502, 'Could not send the sign-in email. Try again.', 'email_failed');
  }

  return json({ ok: true });
});

/**
 * Supported countries, for the onboarding dropdown. `multi_timezone` marks the
 * ones where the default zone is a coin flip and the operator must pick — get
 * this wrong and every working day lands in the wrong hour.
 */
route('GET', '/api/countries', async () =>
  json({
    countries: COUNTRY_LIST.map((c) => ({
      iso2: c.iso2, name: c.name, dial: c.dial, currency: c.currency,
      default_timezone: c.defaultTimezone,
      multi_timezone: c.multiTimezone === true,
      has_postal_codes: c.noPostalCodes !== true,
    })),
  }));

route('POST', '/api/auth/verify', async ({ req, env }) => {
  const b = await body(req);
  const token = str(b.token);
  if (!token) throw badRequest('Missing token.');
  const { cookie } = await consumeLoginToken(env, token, req.headers.get('user-agent'));
  return json({ ok: true }, 200, { 'set-cookie': cookie });
});

route('POST', '/api/auth/logout', async ({ req, env }) => {
  await revokeSession(req, env);
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
});

route('GET', '/api/me', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  return json({ operator: op });
});

const SETTABLE = [
  'business_name', 'trade', 'phone_e164', 'timezone', 'country', 'currency',
  'location_mode', 'fill_model', 'sms_mode', 'home_address', 'home_lat', 'home_lng',
  'min_gap_seconds', 'max_detour_seconds', 'buffer_seconds', 'offer_ttl_seconds',
  'offers_per_wave', 'min_notice_seconds', 'reoffer_cooldown_seconds', 'discount_percent',
] as const;

route('PATCH', '/api/settings', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);

  if (b.country !== undefined && !getCountry(String(b.country))) {
    throw badRequest(`Country "${b.country}" is not supported yet.`, 'unsupported_country');
  }
  if (b.timezone !== undefined) {
    // An invalid IANA name would silently poison every gap this operator has.
    try { new Intl.DateTimeFormat('en', { timeZone: String(b.timezone) }); }
    catch { throw badRequest(`"${b.timezone}" is not a valid timezone.`, 'bad_timezone'); }
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of SETTABLE) {
    if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
  }
  if (!sets.length) throw badRequest('Nothing to update.');
  vals.push(now(), op.id);
  await env.DB.prepare(`UPDATE operators SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...vals).run();
  const fresh = await env.DB.prepare(`SELECT * FROM operators WHERE id = ?`).bind(op.id).first();
  return json({ operator: fresh });
});

// ---------------------------------------------------------------------------
// Working hours & time off
// ---------------------------------------------------------------------------
route('GET', '/api/working-hours', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const rows = await env.DB.prepare(
    `SELECT * FROM working_hours WHERE operator_id = ? ORDER BY weekday, start_minute`,
  ).bind(op.id).all();
  return json({ working_hours: rows.results ?? [] });
});

/** Replaces the whole week in one call — simpler than diffing on the client. */
route('PUT', '/api/working-hours', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const list = Array.isArray(b.working_hours) ? b.working_hours : null;
  if (!list) throw badRequest('Expected { working_hours: [...] }.');
  const t = now();
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM working_hours WHERE operator_id = ?`).bind(op.id),
  ];
  for (const h of list) {
    const wd = int(h.weekday), s = int(h.start_minute), e = int(h.end_minute);
    if (wd === null || s === null || e === null) throw badRequest('Bad working hours entry.');
    if (wd < 0 || wd > 6 || s < 0 || e > 1440 || e <= s) throw badRequest('Bad working hours range.');
    stmts.push(env.DB.prepare(
      `INSERT INTO working_hours (id, operator_id, location_id, weekday, start_minute, end_minute, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(newId(), op.id, str(h.location_id), wd, s, e, t));
  }
  await env.DB.batch(stmts);
  await touchCalendar(env, op.id);
  return json({ ok: true, count: list.length });
});

route('POST', '/api/time-off', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const s = int(b.starts_at), e = int(b.ends_at);
  if (s === null || e === null || e <= s) throw badRequest('starts_at must be before ends_at.');
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO time_off (id, operator_id, starts_at, ends_at, reason, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).bind(id, op.id, s, e, str(b.reason), now()).run();
  await touchCalendar(env, op.id);
  return json({ id }, 201);
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------
route('GET', '/api/services', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const rows = await env.DB.prepare(
    `SELECT * FROM services WHERE operator_id = ? ORDER BY is_active DESC, name`,
  ).bind(op.id).all();
  return json({ services: rows.results ?? [] });
});

route('POST', '/api/services', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const name = str(b.name);
  const duration = int(b.duration_seconds);
  if (!name) throw badRequest('Service needs a name.');
  if (!duration || duration <= 0) throw badRequest('Service needs a duration in seconds.');
  const id = newId(), t = now();
  await env.DB.prepare(
    `INSERT INTO services
       (id, operator_id, name, duration_seconds, min_duration_seconds, max_duration_seconds,
        price_cents, cadence_days, requires_parts, requires_client_present,
        gap_fill_eligible, is_mobile, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, op.id, name, duration, int(b.min_duration_seconds), int(b.max_duration_seconds),
    int(b.price_cents) ?? 0, int(b.cadence_days),
    b.requires_parts ? 1 : 0,
    b.requires_client_present === false ? 0 : 1,
    b.gap_fill_eligible === false ? 0 : 1,
    b.is_mobile === false ? 0 : 1, t, t,
  ).run();
  return json({ id }, 201);
});

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
route('GET', '/api/clients', async ({ req, env, url }) => {
  const op = await requireOperator(req, env);
  const q = url.searchParams.get('q');
  const overdue = url.searchParams.get('overdue') === '1';
  const rows = await env.DB.prepare(
    `SELECT * FROM clients
      WHERE operator_id = ? AND is_active = 1
        AND (? IS NULL OR (first_name || ' ' || COALESCE(last_name,'')) LIKE ?)
        AND (? = 0 OR (next_due_at IS NOT NULL AND next_due_at <= ?))
      ORDER BY (next_due_at IS NULL), next_due_at ASC
      LIMIT 500`,
  ).bind(op.id, q, q ? `%${q}%` : null, overdue ? 1 : 0, now()).all();
  return json({ clients: rows.results ?? [] });
});

route('POST', '/api/clients', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const first = str(b.first_name);
  if (!first) throw badRequest('Client needs a first name.');

  const phone = toE164(str(b.phone_e164), op.country);
  if (str(b.phone_e164) && !phone) {
    throw badRequest('That phone number is not a valid number for your country.', 'bad_phone');
  }
  const consent = b.sms_consent ? 1 : 0;
  if (consent && !phone) throw badRequest('Can not record SMS consent without a phone number.');

  const postcode = str(b.postcode);
  if (postcode && !isValidPostcode(postcode, op.country)) {
    throw badRequest(
      `That does not look like a valid postcode for ${getCountry(op.country)?.name ?? op.country}.`,
      'bad_postcode',
    );
  }

  let lat = b.lat != null ? Number(b.lat) : null;
  let lng = b.lng != null ? Number(b.lng) : null;
  let status: 'pending' | 'ok' | 'failed' | 'manual' = lat != null ? 'manual' : 'pending';
  if (lat == null && (postcode || str(b.address_line))) {
    const p = await geocode(env, str(b.address_line), postcode, op.country);
    if (p) { lat = p.lat; lng = p.lng; status = 'ok'; } else { status = 'failed'; }
  }

  const id = newId(), t = now();
  try {
    await env.DB.prepare(
      `INSERT INTO clients
         (id, operator_id, first_name, last_name, phone_e164, email, address_line, postcode,
          lat, lng, geocode_status, geocoded_at, default_service_id, last_serviced_at,
          next_due_at, sms_consent, sms_consent_at, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, op.id, first, str(b.last_name), phone, str(b.email),
      str(b.address_line), postcode, lat, lng, status, lat != null ? t : null,
      str(b.default_service_id), int(b.last_serviced_at), int(b.next_due_at),
      consent, consent ? t : null, str(b.notes), t, t,
    ).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      throw new HttpError(409, 'You already have a client with that phone number.', 'duplicate_phone');
    }
    throw e;
  }
  return json({ id, geocode_status: status }, 201);
});

route('PATCH', '/api/clients/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const fields = ['first_name', 'last_name', 'email', 'address_line', 'postcode',
    'lat', 'lng', 'default_service_id', 'last_serviced_at', 'next_due_at', 'notes', 'is_active'];
  const sets: string[] = [], vals: unknown[] = [];
  for (const k of fields) if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }

  if (b.phone_e164 !== undefined) {
    const phone = toE164(str(b.phone_e164), op.country);
    if (str(b.phone_e164) && !phone) throw badRequest('Invalid phone number.', 'bad_phone');
    sets.push('phone_e164 = ?'); vals.push(phone);
  }
  if (b.sms_consent !== undefined) {
    sets.push('sms_consent = ?', 'sms_consent_at = ?');
    vals.push(b.sms_consent ? 1 : 0, b.sms_consent ? now() : null);
  }
  if (!sets.length) throw badRequest('Nothing to update.');
  vals.push(now(), params.id, op.id);
  const res = await env.DB.prepare(
    `UPDATE clients SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND operator_id = ?`,
  ).bind(...vals).run();
  if (res.meta.changes === 0) throw notFound('Client not found.');
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Job leads — the break-fix fill source
// ---------------------------------------------------------------------------
route('GET', '/api/leads', async ({ req, env, url }) => {
  const op = await requireOperator(req, env);
  const status = url.searchParams.get('status') ?? 'open';
  const rows = await env.DB.prepare(
    `SELECT l.*, c.first_name, c.last_name, c.phone_e164
       FROM job_leads l JOIN clients c ON c.id = l.client_id
      WHERE l.operator_id = ? AND l.status = ?
      ORDER BY l.urgency DESC, l.created_at ASC LIMIT 500`,
  ).bind(op.id, status).all();
  return json({ leads: rows.results ?? [] });
});

route('POST', '/api/leads', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const title = str(b.title), clientId = str(b.client_id);
  if (!title) throw badRequest('Lead needs a title.');
  if (!clientId) throw badRequest('Lead needs a client_id.');
  const owned = await env.DB.prepare(`SELECT id FROM clients WHERE id=? AND operator_id=?`)
    .bind(clientId, op.id).first();
  if (!owned) throw notFound('Client not found.');

  const id = newId(), t = now();
  await env.DB.prepare(
    `INSERT INTO job_leads
       (id, operator_id, client_id, service_id, title, description, quoted_price_cents,
        quoted_at, estimated_duration_seconds, address_line, postcode, lat, lng,
        parts_required, parts_ready, urgency, status, expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?,?,?)`,
  ).bind(
    id, op.id, clientId, str(b.service_id), title, str(b.description),
    int(b.quoted_price_cents), int(b.quoted_at) ?? t, int(b.estimated_duration_seconds),
    str(b.address_line), str(b.postcode),
    b.lat != null ? Number(b.lat) : null, b.lng != null ? Number(b.lng) : null,
    b.parts_required ? 1 : 0, b.parts_ready === false ? 0 : 1,
    int(b.urgency) ?? 2, int(b.expires_at), t, t,
  ).run();
  return json({ id }, 201);
});

route('PATCH', '/api/leads/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const fields = ['title', 'description', 'quoted_price_cents', 'estimated_duration_seconds',
    'address_line', 'postcode', 'lat', 'lng', 'parts_required', 'parts_ready',
    'urgency', 'status', 'lost_reason', 'expires_at'];
  const sets: string[] = [], vals: unknown[] = [];
  for (const k of fields) if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
  if (!sets.length) throw badRequest('Nothing to update.');
  vals.push(now(), params.id, op.id);
  const res = await env.DB.prepare(
    `UPDATE job_leads SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND operator_id = ?`,
  ).bind(...vals).run();
  if (res.meta.changes === 0) throw notFound('Lead not found.');
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------
route('GET', '/api/appointments', async ({ req, env, url }) => {
  const op = await requireOperator(req, env);
  const from = int(url.searchParams.get('from')) ?? now();
  const to = int(url.searchParams.get('to')) ?? from + 60 * 60 * 24 * 14;
  const rows = await env.DB.prepare(
    `SELECT a.*, c.first_name, c.last_name, c.phone_e164, s.name AS service_name
       FROM appointments a
       LEFT JOIN clients c  ON c.id = a.client_id
       LEFT JOIN services s ON s.id = a.service_id
      WHERE a.operator_id = ? AND a.ends_at > ? AND a.starts_at < ?
      ORDER BY a.starts_at`,
  ).bind(op.id, from, to).all();
  return json({ appointments: rows.results ?? [] });
});

route('POST', '/api/appointments', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const s = int(b.starts_at), e = int(b.ends_at);
  if (s === null || e === null || e <= s) throw badRequest('starts_at must be before ends_at.');

  // Overlap guard: the app owns the calendar, so it must refuse double-booking.
  const clash = await env.DB.prepare(
    `SELECT id FROM appointments
      WHERE operator_id = ? AND status = 'scheduled' AND starts_at < ? AND ends_at > ? LIMIT 1`,
  ).bind(op.id, e, s).first();
  if (clash) throw new HttpError(409, 'That overlaps an existing appointment.', 'overlap');

  const id = newId(), t = now();
  await env.DB.prepare(
    `INSERT INTO appointments
       (id, operator_id, client_id, service_id, lead_id, location_id, starts_at, ends_at,
        is_mobile, address_line, postcode, lat, lng, status, price_cents, source, notes,
        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'scheduled', ?, ?, ?, ?, ?)`,
  ).bind(
    id, op.id, str(b.client_id), str(b.service_id), str(b.lead_id), str(b.location_id),
    s, e, b.is_mobile === false ? 0 : 1, str(b.address_line), str(b.postcode),
    b.lat != null ? Number(b.lat) : null, b.lng != null ? Number(b.lng) : null,
    int(b.price_cents), str(b.source) ?? 'manual', str(b.notes), t, t,
  ).run();
  await touchCalendar(env, op.id);
  return json({ id }, 201);
});

/**
 * Update an appointment: reschedule it, or mark it done.
 *
 * Marking it 'completed' is the event the whole recurring-trade side of the
 * product hangs on. It advances last_serviced_at and recomputes next_due_at
 * from the service cadence, which is what puts the client back into the
 * overdue pool. Without this route the cadence logic in the cron can never
 * fire and the overdue list stays permanently empty.
 */
route('PATCH', '/api/appointments/:id', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const t = now();

  const appt = await env.DB.prepare(
    `SELECT * FROM appointments WHERE id = ? AND operator_id = ?`,
  ).bind(params.id, op.id).first<any>();
  if (!appt) throw notFound('Appointment not found.');

  const starts = b.starts_at !== undefined ? int(b.starts_at) : appt.starts_at;
  const ends = b.ends_at !== undefined ? int(b.ends_at) : appt.ends_at;
  if (starts === null || ends === null || ends <= starts) {
    throw badRequest('starts_at must be before ends_at.');
  }

  const status = str(b.status) ?? appt.status;
  if (!['scheduled', 'completed', 'cancelled', 'no_show'].includes(status)) {
    throw badRequest('Unknown status.');
  }

  // Rescheduling must not land on top of another job.
  if (starts !== appt.starts_at || ends !== appt.ends_at) {
    const clash = await env.DB.prepare(
      `SELECT id FROM appointments
        WHERE operator_id = ? AND status = 'scheduled' AND id <> ?
          AND starts_at < ? AND ends_at > ? LIMIT 1`,
    ).bind(op.id, params.id, ends, starts).first();
    if (clash) throw new HttpError(409, 'That overlaps an existing appointment.', 'overlap');
  }

  const sets: string[] = ['starts_at = ?', 'ends_at = ?', 'status = ?'];
  const vals: unknown[] = [starts, ends, status];
  for (const k of ['price_cents', 'notes', 'address_line', 'postcode', 'lat', 'lng', 'service_id']) {
    if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
  }
  if (status === 'no_show' && appt.status !== 'no_show' && appt.client_id) {
    // Counted here, and used to rank a repeat no-show down for future gaps.
    await env.DB.prepare(
      `UPDATE clients SET no_show_count = no_show_count + 1, updated_at = ? WHERE id = ?`,
    ).bind(t, appt.client_id).run();
  }
  vals.push(t, params.id, op.id);

  await env.DB.prepare(
    `UPDATE appointments SET ${sets.join(', ')}, updated_at = ?
      WHERE id = ? AND operator_id = ?`,
  ).bind(...vals).run();

  // Recompute cadence immediately rather than waiting for the cron, so the
  // operator sees the client leave the overdue list the moment they tap done.
  let nextDue: number | null = null;
  if (status === 'completed' && appt.client_id) {
    const client = await env.DB.prepare(
      `SELECT c.id, c.default_service_id,
              COALESCE(s1.cadence_days, s2.cadence_days) AS cadence_days
         FROM clients c
         LEFT JOIN services s1 ON s1.id = ?
         LEFT JOIN services s2 ON s2.id = c.default_service_id
        WHERE c.id = ? AND c.operator_id = ?`,
    ).bind(appt.service_id, appt.client_id, op.id)
      .first<{ id: string; cadence_days: number | null }>();

    if (client) {
      nextDue = client.cadence_days ? ends + client.cadence_days * 86400 : null;
      await env.DB.prepare(
        `UPDATE clients SET
           last_serviced_at = MAX(COALESCE(last_serviced_at, 0), ?),
           next_due_at = COALESCE(?, next_due_at),
           visit_count = visit_count + 1,
           updated_at = ?
         WHERE id = ? AND operator_id = ?`,
      ).bind(ends, nextDue, t, appt.client_id, op.id).run();
    }
  }

  // Completing or cancelling frees time; a reschedule moves it. Either way the
  // gap picture for that day is now stale.
  await touchCalendar(env, op.id);
  if (status !== 'scheduled' || starts !== appt.starts_at) {
    try { await detectGaps(env, op, Math.min(starts, appt.starts_at), 1); }
    catch (e) { console.error('gap refresh after appointment update failed', e); }
  }

  return json({ ok: true, next_due_at: nextDue });
});

/**
 * Cancel an appointment and immediately turn the hole into a gap.
 * This is the moment the whole product exists for, so detection runs inline
 * rather than waiting for the next cron tick.
 */
route('POST', '/api/appointments/:id/cancel', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const t = now();

  const appt = await env.DB.prepare(
    `SELECT * FROM appointments WHERE id = ? AND operator_id = ?`,
  ).bind(params.id, op.id).first<{ id: string; starts_at: number; ends_at: number; status: string }>();
  if (!appt) throw notFound('Appointment not found.');
  if (appt.status === 'cancelled') return json({ ok: true, already: true });

  await env.DB.prepare(
    `UPDATE appointments SET status='cancelled', cancelled_at=?, cancelled_by=?, updated_at=?
      WHERE id=? AND operator_id=?`,
  ).bind(t, str(b.cancelled_by) ?? 'client', t, params.id, op.id).run();
  await touchCalendar(env, op.id);

  const result = await detectGaps(env, op, appt.starts_at, 1);

  // Tag the gap this cancellation opened, so the dashboard can lead with it.
  await env.DB.prepare(
    `UPDATE gaps SET created_by_cancellation_of = ?, updated_at = ?
      WHERE operator_id = ? AND status = 'open'
        AND starts_at < ? AND ends_at > ?`,
  ).bind(params.id, t, op.id, appt.ends_at, appt.starts_at).run();

  const gaps = await env.DB.prepare(
    `SELECT * FROM gaps
      WHERE operator_id = ? AND status = 'open' AND starts_at < ? AND ends_at > ?`,
  ).bind(op.id, appt.ends_at, appt.starts_at).all();

  return json({ ok: true, detected: result.created, gaps: gaps.results ?? [] });
});

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------
route('POST', '/api/gaps/detect', async ({ req, env }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const from = int(b.from) ?? now();
  const days = Math.min(Math.max(int(b.days) ?? 14, 1), 60);
  const res = await detectGaps(env, op, from, days);
  return json({ ok: true, ...res });
});

route('GET', '/api/gaps', async ({ req, env, url }) => {
  const op = await requireOperator(req, env);
  const from = int(url.searchParams.get('from')) ?? now();
  const to = int(url.searchParams.get('to')) ?? from + 60 * 60 * 24 * 14;
  const rows = await env.DB.prepare(
    `SELECT g.*,
            (SELECT COUNT(*) FROM gap_offers o
              WHERE o.gap_id = g.id AND o.status IN ('sent','delivered','viewed')) AS live_offers
       FROM gaps g
      WHERE g.operator_id = ? AND g.status IN ('open','offering')
        AND g.starts_at >= ? AND g.starts_at < ?
      ORDER BY (g.created_by_cancellation_of IS NULL), g.starts_at`,
  ).bind(op.id, from, to).all<any>();

  const gaps = (rows.results ?? []).map((g) => ({
    ...g,
    label: formatTimeRange(g.starts_at, g.ends_at, op.timezone, localeFor(op.country)),
    duration_minutes: Math.round((g.ends_at - g.starts_at) / 60),
  }));
  return json({ gaps });
});

async function loadGap(env: Env, op: Operator, id: string): Promise<GapRow> {
  const gap = await env.DB.prepare(
    `SELECT * FROM gaps WHERE id = ? AND operator_id = ?`,
  ).bind(id, op.id).first<GapRow>();
  if (!gap) throw notFound('Gap not found.');
  return gap;
}

route('GET', '/api/gaps/:id/candidates', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const gap = await loadGap(env, op, params.id!);
  const candidates = await rankCandidates(env, op, gap);
  return json({
    gap: { ...gap, label: formatTimeRange(gap.starts_at, gap.ends_at, op.timezone, localeFor(op.country)) },
    candidates,
  });
});

/**
 * Send a wave of offers. The operator picks candidate_ids, or we take the top
 * `offers_per_wave` by score. In 'device' mode the response carries prefilled
 * sms: links for the operator to tap — nothing is sent from the server.
 */
route('POST', '/api/gaps/:id/offers', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const b = await body(req);
  const gap = await loadGap(env, op, params.id!);

  if (gap.status === 'filled') throw new HttpError(409, 'That gap is already filled.', 'gap_filled');

  const ranked = await rankCandidates(env, op, gap);
  if (ranked.length === 0) {
    return json({ offers: [], reason: 'No eligible clients or open jobs fit this gap.' });
  }

  let chosen: Candidate[];
  if (Array.isArray(b.candidates) && b.candidates.length) {
    const wanted = new Set<string>(
      b.candidates.map((c: any) => `${c.kind}:${c.client_id}:${c.lead_id ?? ''}`),
    );
    chosen = ranked.filter((c) => wanted.has(`${c.kind}:${c.client_id}:${c.lead_id ?? ''}`));
  } else {
    chosen = ranked.slice(0, op.offers_per_wave);
  }
  if (!chosen.length) throw badRequest('None of those candidates are eligible for this gap.');

  const offers = await createOffers(env, op, gap, chosen);
  return json({ offers, sms_mode: op.sms_mode }, 201);
});

route('POST', '/api/gaps/:id/dismiss', async ({ req, env, params }) => {
  const op = await requireOperator(req, env);
  const res = await env.DB.prepare(
    `UPDATE gaps SET status='dismissed', updated_at=?
      WHERE id=? AND operator_id=? AND status IN ('open','offering')`,
  ).bind(now(), params.id, op.id).run();
  if (res.meta.changes === 0) throw notFound('Gap not found or already closed.');
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Public offer page — plain server-rendered HTML, no React, no login
// ---------------------------------------------------------------------------
function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fbfaf9;--fg:#1c1a17;--mut:#6b6560;--line:#e5e0da;--accent:#1b6b4a}
@media(prefers-color-scheme:dark){:root{--bg:#171513;--fg:#f2efec;--mut:#a49d96;--line:#302b27;--accent:#4ec08b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:26rem;background:color-mix(in srgb,var(--bg) 92%,#fff);
border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:1.35rem;margin:0 0 4px;letter-spacing:-.01em}
.biz{color:var(--mut);font-size:.9rem;margin:0 0 20px}
.slot{font-size:1.5rem;font-weight:650;margin:0 0 6px;letter-spacing:-.02em}
.meta{color:var(--mut);margin:0 0 22px;font-size:.95rem}
form{margin:0}
button{width:100%;padding:14px;border-radius:10px;border:0;font:inherit;font-weight:600;cursor:pointer}
.yes{background:var(--accent);color:#fff;margin-bottom:10px}
.no{background:transparent;color:var(--mut);border:1px solid var(--line)}
.note{color:var(--mut);font-size:.82rem;margin-top:18px;text-align:center}
.big{font-size:2.4rem;margin:0 0 10px}
</style></head><body><div class="card">${inner}</div></body></html>`;
}

route('GET', '/o/:token', async ({ env, params }) => {
  let offer;
  try {
    offer = await loadOfferByToken(env, params.token!);
  } catch {
    return html(page('Link not found',
      `<p class="big">🔗</p><h1>This link isn't valid</h1>
       <p class="meta">Check the text message, or reply to it and we'll sort it out.</p>`), 404);
  }

  const t = now();
  const dead =
    offer.gap_status === 'filled' && offer.status !== 'accepted' ? 'taken'
    : offer.status === 'accepted' ? 'accepted'
    : offer.status === 'declined' ? 'declined'
    : (offer.expires_at != null && offer.expires_at <= t) || offer.starts_at <= t ? 'expired'
    : offer.status === 'superseded' ? 'taken'
    : null;

  const when = formatTimeRange(offer.starts_at, offer.starts_at + offer.duration_seconds,
    offer.timezone, localeFor(offer.country));
  const biz = escapeHtml(offer.business_name);

  if (dead === 'accepted') {
    return html(page('Booked', `<p class="big">✅</p><h1>You're booked in</h1>
      <p class="biz">${biz}</p><p class="slot">${escapeHtml(when)}</p>
      <p class="meta">${escapeHtml(offer.title)}</p>`));
  }
  if (dead === 'taken') {
    return html(page('Slot taken', `<p class="big">😕</p><h1>That slot just went</h1>
      <p class="biz">${biz}</p>
      <p class="meta">Someone took it a moment ago. We'll let you know next time one opens up.</p>`), 410);
  }
  if (dead === 'declined') {
    return html(page('No problem', `<h1>No problem</h1><p class="biz">${biz}</p>
      <p class="meta">We've taken you off this one. You'll hear about the next slot.</p>`));
  }
  if (dead === 'expired') {
    return html(page('Expired', `<p class="big">⌛</p><h1>This offer has expired</h1>
      <p class="biz">${biz}</p>
      <p class="meta">Reply to the text if you'd still like the slot.</p>`), 410);
  }

  await markViewed(env, offer.offer_id);

  const price = offer.quoted_price_cents && offer.quoted_price_cents > 0
    ? `<p class="meta">${escapeHtml(offer.title)} · ${escapeHtml(
        formatMoney(offer.quoted_price_cents, offer.currency, localeFor(offer.country)))}</p>`
    : `<p class="meta">${escapeHtml(offer.title)}</p>`;

  const tok = escapeHtml(params.token!);
  return html(page(`Slot available — ${offer.business_name}`, `
    <h1>Hi ${escapeHtml(offer.first_name)} 👋</h1>
    <p class="biz">${biz} has a slot free</p>
    <p class="slot">${escapeHtml(when)}</p>
    ${price}
    <form method="POST" action="/o/${tok}/accept">
      <button class="yes" type="submit">Yes, book me in</button>
    </form>
    <form method="POST" action="/o/${tok}/decline">
      <button class="no" type="submit">Not this time</button>
    </form>
    <p class="note">First to confirm gets the slot.</p>`));
});

route('POST', '/o/:token/accept', async ({ env, params }) => {
  try {
    const res = await acceptOffer(env, params.token!);
    const o = res.offer;
    const when = formatTimeRange(o.starts_at, o.starts_at + o.duration_seconds,
      o.timezone, localeFor(o.country));
    return html(page('Booked', `<p class="big">✅</p><h1>You're booked in</h1>
      <p class="biz">${escapeHtml(o.business_name)}</p>
      <p class="slot">${escapeHtml(when)}</p>
      <p class="meta">${escapeHtml(o.title)}</p>
      <p class="note">See you then. Reply to the text if anything changes.</p>`));
  } catch (e) {
    const code = e instanceof HttpError ? e.code : undefined;
    if (code === 'slot_taken') {
      return html(page('Slot taken', `<p class="big">😕</p><h1>That slot just went</h1>
        <p class="meta">Someone confirmed a moment before you. We'll let you know next time.</p>`), 410);
    }
    return html(page('No longer available', `<p class="big">⌛</p><h1>This offer has closed</h1>
      <p class="meta">Reply to the text if you'd still like a slot.</p>`), 410);
  }
});

route('POST', '/o/:token/decline', async ({ req, env, params }) => {
  const b = await body(req);
  await declineOffer(env, params.token!, str(b.reason));
  return html(page('No problem', `<h1>No problem</h1>
    <p class="meta">We've taken you off this one. You'll hear about the next slot.</p>`));
});

// ---------------------------------------------------------------------------
// Twilio webhooks (only used when an operator sets sms_mode = 'twilio')
// ---------------------------------------------------------------------------
route('POST', '/webhooks/twilio/inbound', async ({ req, env }) => {
  const form = await req.formData();
  if (!(await verifyTwilioSignature(req, env, form))) {
    // Unsigned means anyone could opt a client out by guessing this URL.
    throw new HttpError(403, 'Invalid signature.', 'bad_signature');
  }
  const from = String(form.get('From') ?? '');
  const text = String(form.get('Body') ?? '').trim().toUpperCase();
  const t = now();

  if (STOP_WORDS.has(text)) {
    await env.DB.prepare(
      `UPDATE clients SET opted_out_at = ?, sms_consent = 0, updated_at = ? WHERE phone_e164 = ?`,
    ).bind(t, t, from).run();
  } else if (START_WORDS.has(text)) {
    await env.DB.prepare(
      `UPDATE clients SET opted_out_at = NULL, sms_consent = 1, sms_consent_at = ?, updated_at = ?
        WHERE phone_e164 = ?`,
    ).bind(t, t, from).run();
  }

  await env.DB.prepare(
    `INSERT INTO messages (id, operator_id, client_id, direction, channel, to_address,
                           from_address, body, status, provider, created_at, updated_at)
     SELECT ?, c.operator_id, c.id, 'in', 'sms', '', ?, ?, 'received', 'twilio', ?, ?
       FROM clients c WHERE c.phone_e164 = ? LIMIT 1`,
  ).bind(newId(), from, String(form.get('Body') ?? ''), t, t, from).run();

  return new Response('<Response></Response>', { headers: { 'content-type': 'text/xml' } });
});

route('POST', '/webhooks/twilio/status', async ({ req, env }) => {
  const form = await req.formData();
  if (!(await verifyTwilioSignature(req, env, form))) {
    throw new HttpError(403, 'Invalid signature.', 'bad_signature');
  }
  const sid = String(form.get('MessageSid') ?? '');
  const status = String(form.get('MessageStatus') ?? '');
  const map: Record<string, string> = {
    sent: 'sent', delivered: 'delivered', undelivered: 'failed', failed: 'failed',
  };
  if (sid && map[status]) {
    await env.DB.prepare(`UPDATE messages SET status=?, updated_at=? WHERE provider_sid=?`)
      .bind(map[status], now(), sid).run();
    if (map[status] === 'delivered') {
      await env.DB.prepare(
        `UPDATE gap_offers SET status='delivered', updated_at=?
          WHERE id = (SELECT offer_id FROM messages WHERE provider_sid=?) AND status='sent'`,
      ).bind(now(), sid).run();
    }
  }
  return new Response('', { status: 204 });
});

route('GET', '/health', async ({ env }) => {
  const r = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return json({ ok: r?.ok === 1, time: now() });
});

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    const pre = preflight(req, env);
    if (pre) return pre;

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]!); });
      try {
        return withCors(await r.handler({ req, env, params, url }), req, env);
      } catch (err) {
        if (err instanceof HttpError) {
          return withCors(json({ error: err.message, code: err.code }, err.status), req, env);
        }
        console.error('unhandled', err);
        return withCors(json({ error: 'Something went wrong.' }, 500), req, env);
      }
    }
    return withCors(json({ error: 'Not found' }, 404), req, env);
  },

  /**
   * Cron. Add to wrangler.toml:
   *   [triggers]
   *   crons = ["*\/15 * * * *"]
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const t = now();

    // Expire offers whose window has closed, and release their gaps.
    await env.DB.prepare(
      `UPDATE gap_offers SET status='expired', updated_at=?
        WHERE status IN ('sent','delivered','viewed','queued') AND expires_at IS NOT NULL
          AND expires_at <= ?`,
    ).bind(t, t).run();

    await env.DB.prepare(
      `UPDATE gaps SET status='open', updated_at=?
        WHERE status='offering'
          AND NOT EXISTS (SELECT 1 FROM gap_offers o
                           WHERE o.gap_id = gaps.id
                             AND o.status IN ('sent','delivered','viewed','queued'))`,
    ).bind(t).run();

    // Gaps whose start time has passed are dead.
    await env.DB.prepare(
      `UPDATE gaps SET status='expired', updated_at=?
        WHERE status IN ('open','offering') AND starts_at <= ?`,
    ).bind(t, t).run();

    // Cadence is recomputed inline when a job is marked completed, so this is
    // only a reconciliation for rows that reached 'completed' another way
    // (an import, a direct edit). Scoped to the last day rather than the whole
    // client table, which used to be rewritten on every tick.
    await env.DB.prepare(
      `UPDATE clients SET
         last_serviced_at = (SELECT MAX(a.ends_at) FROM appointments a
                              WHERE a.client_id = clients.id AND a.status = 'completed'),
         visit_count = (SELECT COUNT(*) FROM appointments a
                         WHERE a.client_id = clients.id AND a.status = 'completed'),
         next_due_at = (
           SELECT MAX(a.ends_at) FROM appointments a WHERE a.client_id = clients.id AND a.status = 'completed'
         ) + COALESCE(
           (SELECT s.cadence_days * 86400 FROM services s WHERE s.id = clients.default_service_id),
           NULL),
         updated_at = ?
       WHERE id IN (
         SELECT DISTINCT a.client_id FROM appointments a
          WHERE a.status = 'completed' AND a.updated_at > ? AND a.client_id IS NOT NULL
       )`,
    ).bind(t, t - 86400).run();

    // Rescan only operators whose calendar actually moved since their last
    // scan, plus anyone not scanned in 24h so the 14-day window rolls forward.
    // Scanning everyone unconditionally is what put the free-tier D1 write
    // ceiling at ~26 operators; this puts it in the hundreds.
    // The batch cap keeps one tick inside the scheduled-worker time limit —
    // whatever it does not reach is still pending on the next tick.
    const ops = await env.DB.prepare(
      `SELECT * FROM operators
        WHERE plan IN ('trial','active')
          AND (scanned_version <> calendar_version
               OR last_scan_at IS NULL
               OR last_scan_at < ?)
        ORDER BY last_scan_at IS NOT NULL, last_scan_at
        LIMIT 200`,
    ).bind(t - 86400).all<Operator & { calendar_version: number }>();

    for (const op of ops.results ?? []) {
      try {
        await detectGaps(env, op, localDayStart(t, op.timezone), 14);
        await env.DB.prepare(
          `UPDATE operators SET scanned_version = ?, last_scan_at = ? WHERE id = ?`,
        ).bind(op.calendar_version, t, op.id).run();
      } catch (e) {
        // Leave scanned_version alone so a failure retries on the next tick.
        console.error('detect failed for', op.id, e);
      }
    }

    // Cache hygiene.
    await env.DB.prepare(`DELETE FROM distance_cache WHERE expires_at < ?`).bind(t).run();
    await env.DB.prepare(`DELETE FROM login_tokens WHERE expires_at < ?`).bind(t - 86400).run();
    await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(t - 86400).run();
  },
};

export { addLocalDays };
