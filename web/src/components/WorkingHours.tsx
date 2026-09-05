/**
 * The seven-row working-hours editor.
 *
 * This markup existed twice — once in the sign-up wizard and once in Settings —
 * as the same checkbox, the same three-letter label and the same pair of
 * `<input type="time">`, down to the identical inline styles. The two copies
 * had already drifted: the wizard had given its checkbox an accessible name and
 * Settings had not, and neither had ever named the time fields, so an axe run
 * over the operator app reported twenty-one unlabelled controls on one screen.
 * Naming them in one place is why this is a component rather than a copy.
 *
 * WHAT THE LABELS SAY, AND WHY THEY ARE NOT THE VISIBLE TEXT. "Mon" beside two
 * unnamed time fields is enough for somebody looking at the row and is nothing
 * at all read aloud: a screen reader user meets "Mon", then "time", then
 * "time". Each field is named for what it actually sets — "Monday start" and
 * "Monday end" — and the weekday is spelled out in full there, because three
 * letters is an abbreviation the eye expands and a voice does not.
 *
 * The state stays with the page. Both callers save it against different
 * endpoints at different moments — the wizard on Next, Settings on its own
 * button — and both read it back out of the same shape, so this draws the rows
 * and reports the changes and owns nothing.
 */

/** One day: whether it is worked at all, and the two wall-clock times. */
export interface DayHours { on: boolean; start: string; end: string }

/** Weekday index to name. Sunday is 0, which is what the Worker stores. */
export const DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

/** Minutes past midnight as the "HH:MM" a time input wants. */
export const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** "HH:MM" back to minutes past midnight. */
export const toMin = (v: string) => {
  const [h = '0', m = '0'] = v.split(':');
  return Number(h) * 60 + Number(m);
};

/** Every day off, nine to five, for a row the caller has no saved answer for. */
export const blankDay = (): DayHours => ({ on: false, start: '09:00', end: '17:00' });

/**
 * The rows a page saves: the days that are switched on, in the Worker's shape,
 * with anything that ends before it starts dropped rather than sent.
 */
export function hoursPayload(hours: Record<number, DayHours>) {
  return Object.entries(hours)
    .filter(([, v]) => v.on)
    .map(([d, v]) => ({
      weekday: Number(d), start_minute: toMin(v.start), end_minute: toMin(v.end),
    }))
    .filter((h) => h.end_minute > h.start_minute);
}

export default function WorkingHours({ hours, onChange, fallback = blankDay }: {
  hours: Record<number, DayHours>;
  onChange: (next: Record<number, DayHours>) => void;
  /** What a day with no saved answer starts as. The two callers differ. */
  fallback?: () => DayHours;
}) {
  const set = (d: number, patch: Partial<DayHours>) =>
    onChange({ ...hours, [d]: { ...(hours[d] ?? fallback()), ...patch } });

  return (
    <>
      {DAY_NAMES.map((name, d) => {
        const h = hours[d] ?? fallback();
        return (
          <div className="card row" key={name} style={{ gap: 10, padding: 12 }}>
            <input type="checkbox" checked={h.on} style={{ width: 20, minHeight: 20 }}
              aria-label={`Work on ${name}`}
              onChange={(e) => set(d, { on: e.target.checked })} />
            <span style={{ width: 38, fontWeight: 600 }} aria-hidden="true">
              {name.slice(0, 3)}
            </span>
            <input type="time" value={h.start} disabled={!h.on}
              aria-label={`${name} start`}
              style={{ minHeight: 40, padding: '8px 10px' }}
              onChange={(e) => set(d, { start: e.target.value })} />
            <input type="time" value={h.end} disabled={!h.on}
              aria-label={`${name} end`}
              style={{ minHeight: 40, padding: '8px 10px' }}
              onChange={(e) => set(d, { end: e.target.value })} />
          </div>
        );
      })}
    </>
  );
}
