/**
 * Wall-clock arithmetic in the operator's own time zone.
 *
 * `new Date('2026-09-04T14:00')` is read in whatever zone the phone is in. An
 * operator posting a slot or entering a booking while away from home would put
 * it up at the wrong hour, and nobody would find out until a customer turned up
 * to an empty drive. Everything here works in a named zone instead.
 *
 * This lived twice over, in Join and in PostOpening, under a comment saying it
 * was repeated because api.ts belonged to somebody else that week. It does not
 * belong to anybody else and a date helper was never api.ts's job anyway, so it
 * is one file that both import.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** Minutes past midnight as the "HH:MM" a time input wants. */
export const hhmm = (mins: number) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

/**
 * A wall-clock date and time in `tz`, as epoch seconds. NaN if unparseable.
 *
 * Two passes: the offset taken at the naive instant is wrong for times sitting
 * on a daylight-saving change, and the second pass lands on the right side of
 * it.
 */
export function epochInZone(date: string, time: string, tz: string): number {
  const naive = Date.parse(`${date}T${time}:00Z`);
  if (Number.isNaN(naive)) return NaN;

  const shift = (ms: number) => {
    const p: Record<string, string> = {};
    for (const part of new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms))) p[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(p.year ?? 0), Number(p.month ?? 1) - 1, Number(p.day ?? 1),
      Number(p.hour ?? 0) % 24, Number(p.minute ?? 0), Number(p.second ?? 0),
    );
    return asUtc - ms;
  };

  const first = naive - shift(naive);
  return Math.round((naive - shift(first)) / 1000);
}

/** Today in `tz`, as the yyyy-mm-dd a date input wants. */
export function todayIn(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA').format(new Date());
  }
}

/**
 * The calendar date an instant falls on in `tz`, as the yyyy-mm-dd a date
 * input and the schedule's own day window both want.
 *
 * The counterpart of epochInZone, and it exists for the same reason: a job at
 * eight in the evening in Los Angeles is already on tomorrow's date in UTC, so
 * turning a start time into a day with the browser's own zone puts a link a
 * day away from the booking it points at — on the one screen an operator reads
 * to find out where they are meant to be.
 */
export function dateIn(epochSeconds: number, tz: string): string {
  const at = new Date(epochSeconds * 1000);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-CA').format(at);
  }
}

/**
 * Whole days from one calendar date to another, either sign.
 *
 * In UTC for the reason addDays gives below: these are dates with no time of
 * day on them, and counting the seconds between two of them in a zone with a
 * clock change in it is a day and an hour, which rounds the wrong way twice a
 * year.
 */
export function daysBetween(from: string, to: string): number {
  const at = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((at(to) - at(from)) / 86_400_000);
}

/**
 * Calendar-date arithmetic, done in UTC on purpose. "Tomorrow" is the next date
 * on the wall calendar, and it stays that even on the day the clocks go
 * forward — adding 86400 seconds to a moment does not.
 */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86_400_000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Minutes past midnight, right now, in `tz`. */
export function nowMinutesIn(tz: string): number {
  try {
    // hourCycle does the work here, not the locale — this only needs a stable
    // HH:MM to parse back out.
    const [h, m] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date()).split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  } catch {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }
}
