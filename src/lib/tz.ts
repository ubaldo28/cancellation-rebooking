/**
 * Timezone helpers.
 *
 * Everything is stored as epoch seconds UTC, but working hours are wall-clock
 * ("I work 9 to 5"). Converting between the two naively breaks twice a year:
 * on a DST boundary a fixed offset puts a gap in the wrong hour. These helpers
 * ask Intl for the real offset at the real instant, so the boundary days work.
 */

const partsCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short',
    });
    partsCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export interface LocalParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  weekday: number;        // 0 = Sunday, matches working_hours.weekday
  minuteOfDay: number;
  dateKey: string;        // 'YYYY-MM-DD' in local time
}

export function toLocal(epochSeconds: number, tz: string): LocalParts {
  const parts = fmt(tz).formatToParts(new Date(epochSeconds * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const year = +get('year'), month = +get('month'), day = +get('day');
  const hour = +get('hour'), minute = +get('minute'), second = +get('second');
  const weekday = WEEKDAYS[get('weekday')] ?? 0;
  return {
    year, month, day, hour, minute, second, weekday,
    minuteOfDay: hour * 60 + minute,
    dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/** Offset in seconds that local time is ahead of UTC at this instant. */
export function offsetSeconds(epochSeconds: number, tz: string): number {
  const p = toLocal(epochSeconds, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return asUtc - epochSeconds;
}

/**
 * Local wall-clock -> epoch seconds. Iterates because the offset depends on
 * the answer. Two passes settle every real zone, including DST transitions.
 *
 * On a spring-forward gap the requested wall time does not exist; we return
 * the instant the clock jumps to, which is the sane booking behaviour.
 */
export function fromLocal(
  tz: string, year: number, month: number, day: number, minuteOfDay: number,
): number {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0) / 1000 + minuteOfDay * 60;
  let guess = naive - offsetSeconds(naive, tz);
  guess = naive - offsetSeconds(guess, tz);
  return guess;
}

/** Epoch seconds for local midnight starting the day that contains `epoch`. */
export function localDayStart(epochSeconds: number, tz: string): number {
  const p = toLocal(epochSeconds, tz);
  return fromLocal(tz, p.year, p.month, p.day, 0);
}

/** Add whole local days, preserving wall-clock time across DST. */
export function addLocalDays(epochSeconds: number, tz: string, days: number): number {
  const p = toLocal(epochSeconds, tz);
  return fromLocal(tz, p.year, p.month, p.day + days, p.minuteOfDay);
}

export function formatLocal(epochSeconds: number, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(epochSeconds * 1000));
}

export function formatTimeRange(startS: number, endS: number, tz: string, locale: string): string {
  const d = new Intl.DateTimeFormat(locale, {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(startS * 1000));
  const t = (s: number) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(s * 1000));
  return `${d}, ${t(startS)}–${t(endS)}`;
}
