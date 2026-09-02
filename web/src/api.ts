/**
 * Worker API client.
 *
 * Auth is a session cookie set by the Worker, so every request sends
 * credentials. In development Vite proxies /api to the Worker so the browser
 * stays on one origin; in production VITE_API_URL points at the deployed
 * Worker and its ALLOWED_ORIGINS must list this site.
 */

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  let body: any = null;
  try { body = await res.json(); } catch { /* empty or non-JSON */ }

  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`, body?.code);
  }
  return body as T;
}

const get = <T>(p: string) => request<T>(p);
const post = <T>(p: string, body?: unknown) =>
  request<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(p: string, body: unknown) =>
  request<T>(p, { method: 'PATCH', body: JSON.stringify(body) });
const put = <T>(p: string, body: unknown) =>
  request<T>(p, { method: 'PUT', body: JSON.stringify(body) });

// ---------------------------------------------------------------------------
// Types mirrored from the Worker
// ---------------------------------------------------------------------------
export interface Operator {
  id: string; email: string; business_name: string; trade: string | null;
  timezone: string; country: string; currency: string; language: string;
  location_mode: 'mobile' | 'premises' | 'hybrid';
  fill_model: 'clients' | 'leads' | 'both';
  sms_mode: 'device' | 'twilio';
  min_gap_seconds: number; max_detour_seconds: number; buffer_seconds: number;
  offers_per_wave: number; discount_percent: number; plan: string;
}

export interface Gap {
  id: string; starts_at: number; ends_at: number;
  is_mobile: number; status: string;
  created_by_cancellation_of: string | null;
  live_offers: number; label: string; duration_minutes: number;
}

export interface Candidate {
  kind: 'client' | 'lead';
  client_id: string; lead_id: string | null; service_id: string | null;
  first_name: string; phone_e164: string | null; language: string | null;
  duration_seconds: number; price_cents: number; title: string;
  overdue_days: number | null; urgency: number | null;
  drive_in_seconds: number | null; drive_out_seconds: number | null;
  detour_seconds: number | null; score: number; reasons: string[];
}

export interface CreatedOffer {
  offer_id: string; client_id: string; first_name: string;
  phone_e164: string | null; url: string; message: string;
  send: { ios: string; android: string; body: string };
  rank: number; score: number; reasons: string[];
}

export interface Appointment {
  id: string; client_id: string | null; service_id: string | null;
  starts_at: number; ends_at: number; status: string;
  address_line: string | null; price_cents: number | null; source: string;
  first_name: string | null; last_name: string | null; service_name: string | null;
}

export interface Client {
  id: string; first_name: string; last_name: string | null;
  phone_e164: string | null; email: string | null;
  address_line: string | null; postcode: string | null;
  geocode_status: string; default_service_id: string | null;
  last_serviced_at: number | null; next_due_at: number | null;
  visit_count: number; no_show_count: number;
  sms_consent: number; opted_out_at: number | null; language: string | null;
}

export interface Lead {
  id: string; client_id: string; title: string; description: string | null;
  quoted_price_cents: number | null; estimated_duration_seconds: number | null;
  parts_required: number; parts_ready: number; urgency: number; status: string;
  first_name: string; last_name: string | null; phone_e164: string | null;
}

export interface Service {
  id: string; name: string; duration_seconds: number; price_cents: number;
  cadence_days: number | null; is_active: number;
}

export interface WorkingHour {
  id: string; weekday: number; start_minute: number; end_minute: number;
}

export interface Country {
  iso2: string; name: string; dial: string; currency: string;
  default_timezone: string; multi_timezone: boolean; has_postal_codes: boolean;
}

// ---------------------------------------------------------------------------
export const api = {
  countries: () => get<{ countries: Country[] }>('/api/countries'),

  requestSignIn: (body: { email: string; business_name?: string; country?: string; timezone?: string }) =>
    post<{ ok: true; sign_in_link?: string }>('/api/auth/request', body),
  verify: (token: string) => post<{ ok: true }>('/api/auth/verify', { token }),
  logout: () => post<{ ok: true }>('/api/auth/logout'),
  me: () => get<{ operator: Operator }>('/api/me'),
  updateSettings: (body: Partial<Operator>) => patch<{ operator: Operator }>('/api/settings', body),

  gaps: (from?: number, to?: number) => {
    const q = new URLSearchParams();
    if (from) q.set('from', String(from));
    if (to) q.set('to', String(to));
    return get<{ gaps: Gap[] }>(`/api/gaps${q.toString() ? `?${q}` : ''}`);
  },
  detectGaps: (days = 14) => post<{ ok: true; created: number }>('/api/gaps/detect', { days }),
  candidates: (gapId: string) =>
    get<{ gap: Gap; candidates: Candidate[] }>(`/api/gaps/${gapId}/candidates`),
  sendOffers: (gapId: string, candidates?: Array<Pick<Candidate, 'kind' | 'client_id' | 'lead_id'>>) =>
    post<{ offers: CreatedOffer[]; sms_mode: string; reason?: string }>(
      `/api/gaps/${gapId}/offers`, candidates ? { candidates } : {}),
  dismissGap: (gapId: string) => post<{ ok: true }>(`/api/gaps/${gapId}/dismiss`, {}),

  appointments: (from: number, to: number) =>
    get<{ appointments: Appointment[] }>(`/api/appointments?from=${from}&to=${to}`),
  createAppointment: (body: Record<string, unknown>) =>
    post<{ id: string }>('/api/appointments', body),
  updateAppointment: (id: string, body: Record<string, unknown>) =>
    patch<{ ok: true; next_due_at: number | null }>(`/api/appointments/${id}`, body),
  cancelAppointment: (id: string, cancelled_by: 'client' | 'operator' = 'client') =>
    post<{ ok: true; gaps: Gap[] }>(`/api/appointments/${id}/cancel`, { cancelled_by }),

  clients: (opts: { q?: string; overdue?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (opts.q) p.set('q', opts.q);
    if (opts.overdue) p.set('overdue', '1');
    return get<{ clients: Client[] }>(`/api/clients${p.toString() ? `?${p}` : ''}`);
  },
  createClient: (body: Record<string, unknown>) => post<{ id: string }>('/api/clients', body),
  updateClient: (id: string, body: Record<string, unknown>) =>
    patch<{ ok: true }>(`/api/clients/${id}`, body),

  leads: (status = 'open') => get<{ leads: Lead[] }>(`/api/leads?status=${status}`),
  createLead: (body: Record<string, unknown>) => post<{ id: string }>('/api/leads', body),
  updateLead: (id: string, body: Record<string, unknown>) =>
    patch<{ ok: true }>(`/api/leads/${id}`, body),

  services: () => get<{ services: Service[] }>('/api/services'),
  createService: (body: Record<string, unknown>) => post<{ id: string }>('/api/services', body),

  workingHours: () => get<{ working_hours: WorkingHour[] }>('/api/working-hours'),
  setWorkingHours: (working_hours: Array<{ weekday: number; start_minute: number; end_minute: number }>) =>
    put<{ ok: true }>('/api/working-hours', { working_hours }),
};

// ---------------------------------------------------------------------------
// Formatting — always driven by the operator's own country and language.
// ---------------------------------------------------------------------------
export const localeFor = (op: Pick<Operator, 'country' | 'language'> | null) =>
  op ? `${op.language || 'en'}-${op.country}` : 'en-US';

export function money(cents: number, op: Operator | null): string {
  if (!op) return String(cents / 100);
  const zeroDecimal = ['JPY', 'KRW', 'CLP', 'ISK', 'VND'].includes(op.currency);
  try {
    return new Intl.NumberFormat(localeFor(op), {
      style: 'currency', currency: op.currency,
      minimumFractionDigits: zeroDecimal ? 0 : 2,
      maximumFractionDigits: zeroDecimal ? 0 : 2,
    }).format(zeroDecimal ? cents : cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${op.currency}`;
  }
}

export function timeRange(startS: number, endS: number, op: Operator | null): string {
  const tz = op?.timezone ?? 'UTC';
  const loc = localeFor(op);
  const day = new Intl.DateTimeFormat(loc, {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(startS * 1000));
  const t = (s: number) => new Intl.DateTimeFormat(loc, {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(s * 1000));
  return `${day}, ${t(startS)}–${t(endS)}`;
}

export function clockTime(s: number, op: Operator | null): string {
  return new Intl.DateTimeFormat(localeFor(op), {
    timeZone: op?.timezone ?? 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(s * 1000));
}

export function shortDate(s: number, op: Operator | null): string {
  return new Intl.DateTimeFormat(localeFor(op), {
    timeZone: op?.timezone ?? 'UTC', day: 'numeric', month: 'short',
  }).format(new Date(s * 1000));
}

export const durationLabel = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
};

/** How late a client is, in the same words the Worker uses. */
export function lateLabel(days: number | null): string | null {
  if (days === null) return null;
  if (days < 0) return days === -1 ? 'due tomorrow' : `due in ${-days} days`;
  if (days === 0) return 'due today';
  if (days < 14) return `${days} days late`;
  return `${Math.floor(days / 7)} weeks late`;
}
