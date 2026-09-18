import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api, durationLabel, photoUrl, sentence,
  type MapArea, type PublicProfileResponse, type PublicSlot, type Review,
  type SimilarBusiness,
} from '../api';
import { ErrorNote, Icon, Spinner, Stars } from '../components/ui';
import Crumbs from '../components/Crumbs';
import { PAY_TODAY_SHORT } from '../components/PaymentState';
import Enquiry, { type EnquiryKind } from '../components/Enquiry';
import PublicPage from '../components/PublicPage';
import SlotCard from '../components/SlotCard';
import { DAY_NAMES } from '../components/WorkingHours';
import '../styles-profile.css';
import { useNoIndex } from '../lib/noindex';
import { absoluteUrl } from '../lib/origin';
import { jsonLd, tradeHref } from '../lib/seo';
import { useDocumentTitle } from '../lib/title';
import { distinctGaps } from '../lib/slots';

/**
 * A business profile, built from the reference marketplace listing.
 *
 * The layout is theirs, block for block, because it is the product of a lot
 * more testing than this project can do and because every block answers a
 * question somebody deciding whether to let a stranger into their house
 * actually asks:
 *
 *   avatar, name, score, review count   — read in that order, before anything
 *   the action                          — never below the fold. On their page
 *                                         the action is their own open hours,
 *                                         not a link to the whole trade
 *   About                               — their own voice
 *   Overview                            — icon rows: hired N times, checked,
 *                                         N people, N years
 *   Services offered                    — green ticks: what they have listed,
 *                                         and WHICH WAY THEY TRAVEL
 *   Photos
 *   Reviews                             — score, five bars, the words people
 *                                         use most as chips, then each review
 *                                         with its date, its verified badge,
 *                                         the exact options booked, and the
 *                                         customer's own photos
 *   Credentials                         — a background check and a name
 *   FAQs
 *
 * Two details from the reference that were arguments here and are settled by
 * looking at it: their credentials section is a background check and nothing
 * else, and "I travel to my customers" is a plain line under Services offered
 * rather than a compliance question.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS PAGE DEPARTS FROM THE REFERENCE, AND WHY EVERY DEPARTURE IS THE
 * SAME DEPARTURE.
 *
 * The reference is a marketplace with a decade of completed jobs behind it.
 * Almost every module in the list above is, underneath, a claim that platform
 * is entitled to make and this one is not: a green shield beside a name, a
 * "Top Pro" ribbon, "responds in about 20 minutes", "licence verified", a
 * guarantee with a figure attached. Copying the shape of those modules without
 * the machinery behind them is not a design decision, it is a forgery — the
 * reader cannot tell a badge that was earned from a badge that was drawn, and
 * the whole point of the badge is that they should not have to.
 *
 * So the rule this file is now built around, and which every block below obeys:
 *
 *   NOTHING IS RENDERED AS AN ENDORSEMENT BY ROUNDTHEWAY. There are no badges
 *   on this page. No verification mark, no background-check shield, no
 *   licence-verified tick, no top-rated ribbon. Nobody here checks any of those
 *   things, and a mark that says otherwise is a lie told at scanning speed.
 *
 *   A NUMBER IS PRINTED ONLY IF THE PAYLOAD CARRIES IT. Hire counts, response
 *   times, ratings and review counts are read off `data` or they are absent.
 *   None of them is estimated, rounded up from something adjacent, or
 *   substituted for by a friendly word.
 *
 *   A FACT THE BUSINESS TOLD US IS LABELLED AS A FACT THE BUSINESS TOLD US, IN
 *   WORDS, BESIDE IT. Years in the trade, employees, a background check, a
 *   licence, insurance: every one of these is typed into a form by the person
 *   it flatters. That is worth showing — it is genuinely what the customer
 *   wants to know — and it is worth showing honestly, which means "they say"
 *   rather than a tick that reads as "we checked".
 *
 * WHAT REPLACES THE MODULES THAT HAD TO GO. The reference's trust furniture
 * answers "is this person safe" with a badge. On a site of solo mobile traders
 * who drive to a stranger's kerb, the questions that actually decide the job
 * are answerable from real rows and are more useful than any badge would have
 * been:
 *
 *   Where they work                     — which way they travel, the
 *                                         neighbourhoods they have listed, and
 *                                         plainly what is NOT on that list
 *   Openings this week                  — their own free hours, by day
 *   Before they arrive                  — what a mobile trade needs at the kerb
 *                                         (parking, water, power, access), put
 *                                         as questions to ask them, because the
 *                                         site holds no answers to them
 *
 * See the comment above each of those for what it refuses to say and why.
 */

const SORTS = [
  { key: 'relevant', label: 'Most relevant' },
  { key: 'highest', label: 'Highest rated' },
  { key: 'lowest', label: 'Lowest rated' },
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
];

const WORK_LOCATION: Record<string, string[]> = {
  i_travel: ['I travel to my customers'],
  they_travel: ['My customers travel to me'],
  both: ['My customers travel to me', 'I travel to my customers'],
};

/**
 * The same three values again, as a sentence rather than a tick.
 *
 * The tick list above is the reference's wording and it stays where it is,
 * under Services offered, because it is how an operator answered the question
 * in their own settings. But "I travel to my customers" under a heading is a
 * fragment of a form, and the thing a customer is actually deciding — do they
 * come to my drive, or do I take the car to them — deserves to be said in the
 * second person somewhere they will read it.
 *
 * Written from the customer's side, therefore, not the operator's: the person
 * reading this is not the one who filled the form in.
 */
const TRAVEL_PROSE: Record<string, string> = {
  i_travel: 'They drive to you. The work happens wherever you are — your drive, '
    + 'your kerb, your car park — and there is nowhere for you to bring anything to.',
  they_travel: 'You go to them. This business does not drive out to customers, '
    + 'so the job happens at a place they will arrange with you.',
  both: 'Either way round. They will drive out to you, and they also take work '
    + 'at a place of their own — agree which one before the day.',
};

/**
 * WHAT A MOBILE TRADE NEEDS FROM THE KERB, PUT AS QUESTIONS.
 *
 * The reference has a requirements module here, filled in by the pro. This
 * site has no such column: `services` carries the operator's working notes and
 * the public profile query deliberately does not select them, and nothing
 * anywhere records whether a particular business needs an outside tap or a
 * 13-amp socket. So this block cannot answer any of these, and it does not try.
 *
 * It asks them instead, which is not a fudge — it is the single most useful
 * thing this page can do about it. Every one of these is a real reason a mobile
 * job gets abandoned on the day: the detailer arrives to permit-only parking,
 * the pressure washer finds a capped tap, the mechanic cannot get a bay wide
 * enough to open a door. The customer is the only person who knows the answer
 * and the operator is the only person who knows which ones matter for their
 * trade, so the honest move is to put the questions between them before
 * somebody loses an afternoon.
 *
 * NOTHING HERE IS PHRASED AS A REQUIREMENT OF THIS BUSINESS. "They need an
 * outside tap" would be inventing a fact about a person from their trade
 * name — which is exactly the class of thing the rest of this file refuses.
 */
const ON_SITE_QUESTIONS = [
  'Where do they need to park, and for how long? Permit bays, gated drives and '
    + 'narrow kerbs are worth mentioning before the day rather than on it.',
  'Do they need water from your outside tap, or do they carry their own?',
  'Do they need mains power, or does everything run off the van?',
  'How do they get to the work — a gate code, a lift, a flight of stairs, a dog '
    + 'in the garden?',
  'Does somebody need to be in, and for the whole job or only to let them in?',
];

/** How many of a business's openings are laid out before asking for more. */
const OPEN_PAGE = 6;

/**
 * How many weekdays the hours block prints before it asks to be opened.
 *
 * Two, because seven lines of times is the longest uninterrupted list on the
 * page and almost nobody reads it: the question somebody actually arrives with
 * is "can they come", which the openings block above answers outright. The week
 * is still here in full for the reader who wants it, one button away.
 */
const HOURS_SHUT = 2;

/**
 * The size of the `similar` array the profile payload carries. A shorter array
 * than this is the server saying it found no more, which is what lets the "see
 * all" hide itself rather than fetching to discover it has nothing to add.
 */
const SIMILAR_IN_PAYLOAD = 3;

/**
 * THE TWO BLOCKS THIS PAGE USED TO REFUSE TO DRAW, and what changed.
 *
 * It carried a note here saying business hours and the full service list could
 * not be shown because `/api/public/profile/:slug` did not return them, and
 * that writing either without the rows would mean inventing a week and a price
 * list for every business on the site. The endpoint returns both now —
 * `services` and `working_hours`, with the `timezone` that makes the second one
 * readable — so both are drawn from those rows and from nothing else.
 *
 * WHAT THE HOURS BLOCK IS CAREFUL ABOUT.
 *
 *   THE TIMEZONE IS THE BUSINESS'S, NOT THE READER'S. `start_minute` is
 *   minutes from midnight where the business is; 1080 is 18:00 in Los Angeles
 *   and it is not 02:00 for somebody reading this in Berlin. These numbers are
 *   printed as wall-clock times exactly as they arrive, never fed through a
 *   Date and re-projected, and the block names the zone underneath so nobody
 *   has to guess whose afternoon it is.
 *
 *   A DAY WITH NO ROW IS A CLOSED DAY, AND IT IS SAID. Leaving Sunday out of
 *   the list makes a reader work out its absence, and a reader who does not
 *   work it out assumes the business is open. Every weekday gets a line.
 *
 *   NO ROWS AT ALL IS NOT A WEEK OF CLOSED DAYS. An operator who has never set
 *   hours has an empty array, which means they have not said — so the block
 *   does not render, rather than drawing a business that is shut seven days a
 *   week. This is the same rule the cards follow: an absence is rendered as an
 *   absence or not at all.
 *
 * WHAT THE SERVICE LIST IS CAREFUL ABOUT. `services` is everything the
 * business sells, which is what the heading has always claimed and what the
 * page could not previously deliver. The prices, though, are still the
 * Worker-formatted strings off the open appointments: `PublicService` carries
 * `price_cents` and no currency, and picking one here — from the country, from
 * a default, from anywhere — would be this page deciding what a number means.
 * So a service the business has an opening for shows what that opening is
 * listed at, a service with no opening shows how long it takes, and the note
 * under the list says which is which.
 */

const monthYear = (s: number) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(s * 1000));

/**
 * Minutes from midnight as the business's own wall clock, in the same 24-hour
 * shape `clockTime` prints everywhere else on the site.
 *
 * Arithmetic on the number rather than a Date, deliberately. Building a Date
 * from these minutes means choosing an instant, and there is no instant here:
 * "opens at 08:00" is a fact about a clock on a wall in Los Angeles, true on
 * every day of the year including the two the clocks change. Anything that
 * routes through a timestamp can be an hour out twice a year for no reason.
 */
const wallClock = (minutes: number) => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * The short name of a zone as it is right now — "PDT" — for the line that says
 * whose clock these times are on.
 *
 * Falls back to the IANA name, which is what the Worker sends and is never
 * wrong even when it is ugly. A zone this browser has never heard of throws
 * rather than returning nothing, hence the catch.
 */
function zoneLabel(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, timeZoneName: 'short',
    }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? timezone;
  } catch {
    return timezone;
  }
}

/**
 * WHICH DAY AN OPENING FALLS ON — AND WHOSE DAY IT IS.
 *
 * The business's, not the reader's, for exactly the reason `wallClock` gives
 * above: an 18:00 opening in Los Angeles is a Thursday evening there whatever
 * clock the person reading this is on, and a reader in Berlin who is shown it
 * grouped under Friday has been told something false about when the van turns
 * up. `starts_at` is a real instant, so unlike the working-hours numbers it can
 * and must be projected — into the operator's zone.
 *
 * Two functions rather than one because they want different things: the key is
 * sortable and never shown, the heading is shown and never compared. Deriving
 * the heading from the key would mean parsing a date back out of a string that
 * only exists to be an identity.
 */
function dayKey(startsAt: number, timezone: string): string {
  try {
    // en-CA gives YYYY-MM-DD, which sorts lexically in the same order it sorts
    // chronologically. Nothing else about the locale is used or shown.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(startsAt * 1000));
  } catch {
    // A zone this browser has never heard of. Falling back to one bucket for
    // everything is right: an ungrouped list is still a true list, whereas
    // grouping by the reader's own midnight would silently move appointments
    // between days.
    return 'all';
  }
}

function dayHeading(startsAt: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'long', month: 'short', day: 'numeric',
    }).format(new Date(startsAt * 1000));
  } catch {
    return 'Open hours';
  }
}

export default function PublicProfile() {
  const { slug } = useParams<{ slug: string }>();
  const [data, setData] = useState<PublicProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [sort, setSort] = useState('relevant');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  /**
   * The public map, or null while it has not answered — and null for good if
   * it never does.
   *
   * Fetched apart from the profile and allowed to fail on its own: the page is
   * the business, and what they happen to have free this week is a block on
   * it. Holding the whole profile back for it, or failing the profile when it
   * fails, would be letting the smaller fact break the larger one.
   */
  const [map, setMap] = useState<{ slots: PublicSlot[]; areas: MapArea[] } | null>(null);
  const [openLimit, setOpenLimit] = useState(OPEN_PAGE);
  const [hoursOpen, setHoursOpen] = useState(false);
  /** What the share control just did, in words, for the live region under it. */
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  /** The rest of the alternatives, once somebody has asked to see them all. */
  const [alts, setAlts] = useState<SimilarBusiness[] | null>(null);
  const [altsOpen, setAltsOpen] = useState(false);
  const [altsBusy, setAltsBusy] = useState(false);
  const [altsErr, setAltsErr] = useState<string | null>(null);
  /**
   * The openings block, held as state rather than in a ref because it does not
   * exist until the profile has loaded and an effect has to re-run when it
   * appears. It is what the phone's bottom bar watches.
   */
  const [ctaEl, setCtaEl] = useState<HTMLElement | null>(null);
  const [barOn, setBarOn] = useState(false);
  /**
   * Which enquiry dialog is up, if any.
   *
   * Held here rather than inside the component so that the three places that
   * offer the action — the block in the flow, the rail and the phone bar — are
   * three buttons onto one dialog rather than three dialogs.
   */
  const [enquiry, setEnquiry] = useState<EnquiryKind | null>(null);

  useDocumentTitle(data?.operator.business_name ?? null);

  /**
   * A slug with no business behind it is answered with the SPA shell and a
   * 200 — see `toSpa` in src/index.ts — so without this every mistyped or
   * retired profile URL is an indexable page apologising for itself. The
   * failure branch is in here deliberately: a profile this page could not
   * fetch has nothing worth indexing on it either, and the tag comes straight
   * back off the moment a retry succeeds.
   */
  useNoIndex(!loading && !data);

  /**
   * THE PHONE BAR APPEARS ONLY ONCE THE ACTION HAS SCROLLED AWAY.
   *
   * Pinning it from the top would put two copies of the same button on the
   * first screen, one of them covering the page, which is worse than no bar at
   * all. So it is tied to the openings block: while that block is on screen the
   * action is already in front of the reader and the bar stays out of the DOM's
   * way; once it leaves, the bar takes over. A browser with no
   * IntersectionObserver gets the bar permanently, which is the safe failure —
   * the action is reachable either way and the page reserves the height for it.
   */
  useEffect(() => {
    if (!ctaEl) return;
    if (typeof IntersectionObserver === 'undefined') { setBarOn(true); return; }
    const io = new IntersectionObserver(
      ([entry]) => setBarOn(!(entry?.isIntersecting ?? false)),
      { rootMargin: '-72px 0px 0px 0px' },
    );
    io.observe(ctaEl);
    return () => io.disconnect();
  }, [ctaEl]);

  /**
   * Hand the address to the platform's own share sheet, and to the clipboard
   * where there is not one.
   *
   * Both endings are said out loud, because they are not interchangeable: a
   * share sheet is visible and needs no explanation, whereas a silent copy is
   * indistinguishable from a button that did nothing. Dismissing the sheet is
   * an AbortError and is not a failure — it clears the message rather than
   * reporting one, and does not fall through to copying something the person
   * has just decided not to share.
   */
  const share = useCallback(async () => {
    const url = window.location.href;
    const title = data?.operator.business_name ?? 'Round The Way';
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title, url });
        setShareMsg('Shared with your device’s share options.');
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          setShareMsg(null);
          return;
        }
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setShareMsg('Link copied. Paste it anywhere to share this page.');
    } catch {
      setShareMsg('This browser would not let the page copy for you — the '
        + 'address of this page is in the address bar.');
    }
  }, [data]);

  /**
   * Everyone else the server has, rather than the three the profile arrived
   * with. Fetched once and kept, so closing and reopening the list is free.
   */
  const seeAllAlts = useCallback(async () => {
    if (!slug || altsBusy) return;
    if (alts) { setAltsOpen((v) => !v); return; }
    setAltsBusy(true); setAltsErr(null);
    try {
      const res = await api.similarBusinesses(slug, 24);
      setAlts(res.businesses);
      setAltsOpen(true);
    } catch (e) {
      setAltsErr(e instanceof Error ? e.message : 'Could not load the rest.');
    } finally {
      setAltsBusy(false);
    }
  }, [slug, alts, altsBusy]);

  const load = useCallback(async () => {
    if (!slug) return;
    setLoading(true); setError(null);
    try { setData(await api.publicProfile(slug)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load this business.'); }
    finally { setLoading(false); }
  }, [slug]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await api.publicMap();
        if (live) setMap({ slots: res.slots, areas: res.areas });
      } catch {
        // Nothing to say and nothing to retry: the page falls back to sending
        // the visitor to the trade, which is where it used to send everybody.
      }
    })();
    return () => { live = false; };
  }, []);

  /** Slug to the name the business wrote, for the cards' neighbourhood line. */
  const areaName = useMemo(
    () => new Map((map?.areas ?? []).map((a) => [a.slug, a.name] as const)),
    [map]);

  /**
   * THIS BUSINESS'S OWN OPEN APPOINTMENTS.
   *
   * Matched on `profile_slug` rather than on an operator id, because the
   * profile endpoint deliberately strips the id — it is the one column
   * `getPublicProfile` removes before answering — and the slug in the address
   * bar identifies exactly the same business. A row is in this list because
   * the public map returned it against this slug, so everything on the cards
   * is the same data the front page and the trade page are showing.
   *
   * Null means the map has not answered, which is a different thing from a
   * business with nothing free and has to stay distinguishable: the first
   * gets the link this page has always had, the second gets told plainly.
   *
   * The de-duplication is because a whole free day is offered in every
   * neighbourhood its business covers, so one opening can come back several
   * times with different `area_slug` values. Soonest first, since the reason
   * anybody is reading this block is that they want it done.
   */
  const mine = useMemo(() => {
    if (!map || !slug) return null;
    return distinctGaps(map.slots.filter((s) => s.profile_slug === slug))
      .sort((a, b) => a.starts_at - b.starts_at);
  }, [map, slug]);

  /**
   * What each service is listed at in the openings this business has open now,
   * keyed by service id.
   *
   * The label is the string the Worker already formatted, never a number
   * reassembled here with a currency symbol guessed at, and it becomes a range
   * only when two openings for the same service really are listed at two
   * different prices. Keyed on `service_id` rather than on the name, because
   * the full list below is joined to it by id and two services can share a
   * name across a rename.
   */
  const priceByService = useMemo(() => {
    const by = new Map<string, PublicSlot[]>();
    for (const s of mine ?? []) {
      if (!s.service_id) continue;
      const rows = by.get(s.service_id);
      if (rows) rows.push(s); else by.set(s.service_id, [s]);
    }
    return new Map([...by.entries()].map(([id, rows]) => {
      const sorted = [...rows].sort((a, b) => a.price_cents - b.price_cents);
      const low = sorted[0]!;
      const high = sorted[sorted.length - 1]!;
      return [id, low.price_cents === high.price_cents
        ? low.price : `${low.price} – ${high.price}`] as const;
    }));
  }, [mine]);

  /**
   * The visible openings, cut into the days they fall on.
   *
   * The reference's availability module is a row of days, and it is right to
   * be: "can they come Saturday" is one question and "can they come at 9" is a
   * different, later one, and a flat list of eighteen cards makes the reader do
   * the first by eye. `mine` is already soonest-first, so consecutive grouping
   * is enough and no second sort is needed.
   *
   * Grouped AFTER the limit rather than before it, so that "show 6 more" adds
   * six appointments — not six days, which on a business with one free hour a
   * day would quietly be six times as many.
   */
  const openDays = useMemo(() => {
    const tz = data?.operator.timezone;
    if (!mine || !tz) return [];
    const groups: Array<{ key: string; heading: string; slots: PublicSlot[] }> = [];
    for (const s of mine.slice(0, openLimit)) {
      const key = dayKey(s.starts_at, tz);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.slots.push(s);
      else groups.push({ key, heading: dayHeading(s.starts_at, tz), slots: [s] });
    }
    return groups;
  }, [mine, openLimit, data]);

  /**
   * The week, one entry per weekday, Monday first.
   *
   * Monday rather than Sunday: the rows are indexed 0 = Sunday because that is
   * what the Worker stores, but a week of business hours is read Monday to
   * Sunday and putting Sunday at the top makes a reader hunt for the weekdays.
   *
   * A weekday can carry several bands — a lunch break is two rows — so they are
   * collected and sorted rather than assumed to be one, and a day with none is
   * kept with an empty list so the block below can say it is closed instead of
   * quietly dropping it.
   */
  const week = useMemo(() => {
    const rows = data?.working_hours ?? [];
    return [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({
      weekday,
      bands: rows
        .filter((h) => h.weekday === weekday)
        .sort((a, b) => a.start_minute - b.start_minute),
    }));
  }, [data]);

  /**
   * Search and sort happen in the browser.
   *
   * The page already has every review it is going to show, so a round trip to
   * re-sort twenty rows would add a spinner to something that should feel
   * instant. If a business ever has enough reviews for that to stop being
   * true, this moves to the server and the endpoint already takes a sort.
   */
  const shown = useMemo(() => {
    const list = [...(data?.reviews ?? [])];
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? list.filter((r) => (r.body ?? '').toLowerCase().includes(needle)
        || (r.details ?? '').toLowerCase().includes(needle))
      : list;
    const by: Record<string, (a: Review, b: Review) => number> = {
      highest: (a, b) => b.rating - a.rating || b.created_at - a.created_at,
      lowest: (a, b) => a.rating - b.rating || b.created_at - a.created_at,
      newest: (a, b) => b.created_at - a.created_at,
      oldest: (a, b) => a.created_at - b.created_at,
      // "Most relevant": the ones with something written, longest first. A
      // five-star with no words tells a reader nothing.
      relevant: (a, b) => (b.body?.length ?? 0) - (a.body?.length ?? 0),
    };
    return filtered.sort(by[sort] ?? by.relevant!);
  }, [data, q, sort]);

  if (loading) return <PublicPage className="pro"><Spinner label="Loading this business" /></PublicPage>;
  if (error) {
    return <PublicPage className="pro"><ErrorNote error={error} onRetry={load} /></PublicPage>;
  }
  /*
   * Neither loading nor failed, and still nothing to draw. The only route into
   * this state is an address with no slug in it, which is not something the
   * visitor can act on — so it says so and points at the front page. It used to
   * `return null`, which rendered a completely blank white document.
   */
  if (!data) {
    return (
      <PublicPage className="pro">
        <div className="blank">
          <p style={{ margin: '0 0 14px' }}>
            There is no business page at this address. It has probably been
            mistyped, or the business has taken their page down.
          </p>
          <Link className="btn sm" to="/">See what is open near you</Link>
        </div>
      </PublicPage>
    );
  }

  const { operator: o, photos, rating, mentions, faqs, areas, services, metro } = data;
  const long = (o.bio ?? '').length > 420;
  const bio = long && !expanded ? `${o.bio!.slice(0, 420)}…` : o.bio;

  /*
   * THE JUMP LIST, BUILT FROM WHAT IS ACTUALLY BELOW IT.
   *
   * Every entry here repeats the condition the section itself is rendered
   * under, rather than naming the five sections the page is known to have. A
   * link to a Photos heading that a business with no photographs never drew
   * scrolls nowhere, leaves focus where it was and looks like a broken page —
   * and it is the businesses with the least on their profile, who can least
   * afford to look broken, that would get it. About and Photos come and go;
   * the other three are unconditional in the markup below and so are here.
   */
  const sections = [
    ...(bio ? [{ id: 'pro-about', label: 'About' }] : []),
    { id: 'pro-services', label: 'Services' },
    { id: 'pro-where', label: 'Where they work' },
    ...(photos.length > 0 ? [{ id: 'pro-photos', label: 'Photos' }] : []),
    { id: 'pro-onsite', label: 'Before they arrive' },
    { id: 'pro-reviews', label: 'Reviews' },
    { id: 'pro-credentials', label: 'Credentials' },
  ];

  /*
   * THE ONE ACTION, IN THE THREE PLACES IT NOW APPEARS.
   *
   * The block in the flow, the rail beside it and the bar across the bottom of
   * a phone are one decision rendered three times, so the decision is made once
   * here. `mine === null` is the map not having answered and is not the same as
   * a business with nothing free: the first falls back to the trade, the second
   * says so and then falls back to the trade.
   */
  const tradeTo = o.trade ? tradeHref(o.trade) : '/';
  const tradeLabel = o.trade
    ? `See what is open in ${o.trade}`
    : 'See what is open near you';
  const openCount = mine?.length ?? 0;
  const openLabel = openCount === 1
    ? 'One appointment open'
    : `${openCount} appointments open`;

  /** The alternatives to draw: the payload's three, or everyone once asked. */
  const shownAlts = altsOpen && alts ? alts : data.similar;

  return (
    <PublicPage className="pro">
      {/* The trail is a real link out to the trade now, not a dead word.
          Somebody who arrived here from a search engine and decided this is
          not their business needs a way sideways to the others doing the
          same work, and the crumb is where every marketplace puts it.
          Crumbs prepends Round The Way itself, which is why it is not here. */}
      <Crumbs items={[
        ...(o.trade
          ? [{ label: sentence(o.trade), to: tradeHref(o.trade) }]
          : []),
        { label: o.business_name },
      ]} />

      {/*
        THE BUSINESS, AS STRUCTURED DATA, AND WHY IT HAS TO BE EMITTED HERE.

        The Worker renders this same URL and puts its own copy of this node
        inside #root, which is where `createRoot().render()` in main.tsx throws
        it away the instant this bundle executes — deliberately, so that a
        rendering crawler is never shown two of everything. Read the comment
        over `intoShell` in src/lib/seo.ts for the bargain that is, and the one
        in main.tsx for what this app owes in return: every route the Worker
        renders into has to re-state the structured data it just deleted.

        This page did not, and it is the page where that costs the most. A
        profile is the only thing on the site that is a business with a score
        attached, so the LocalBusiness entity and the AggregateRating — the
        stars in a search result, which are the whole rich-result opportunity
        here — existed in the first response and were gone a few hundred
        milliseconds later. The breadcrumb above survived only because Crumbs
        emits its own.

        WHAT THIS NODE WAS, AND WHY NONE OF IT COULD EVER HAVE FIRED. It was
        typed `['Product','LocalBusiness']` with a name, a URL and a list of
        areas — no `address`, no `image`, no `@id`. Google requires `address`
        on a LocalBusiness and `image` on a Product before either can produce a
        rich result, so this was a node that satisfied neither of the two types
        it claimed while carrying an aggregateRating for the benefit of
        nothing. The stars this page exists to win were never available to it.
        The Worker has stopped emitting that shape; a rendering crawler sees
        THIS copy, so this is the one that had to change.

        It is the same shape as the Worker's `businessLd` in src/lib/seo.ts
        now, node for node — read that function before editing this one:

        - ONE LocalBusiness. Product is gone. This is a business somebody
          books, not a thing somebody buys, and claiming both types while
          satisfying neither was the whole defect.
        - `@id`, the profile URL, which is what lets the offers on every /near
          page reference this same business rather than each minting an
          anonymous copy of it.
        - `address`, a locality and region off the metro this business's own
          service areas put it in — sent down in the payload as `metro`, so
          there is no second request to make. NEVER A STREET LINE: these
          businesses work out of a vehicle, have no premises, and have never
          given this product an address for one. Inventing a `streetAddress` to
          satisfy a validator would be filing a fact about somebody's business
          that nobody here knows.
        - `image`, their own avatar or one of their own work photographs, and
          nothing at all when they have neither — never a stock photograph,
          which costs the rich result and is the only honest answer.
        - A RATING ONLY WHERE A REVIEW ROW EXISTS. No placeholder, no "5.0 (0)",
          no rounding a rating out of nothing. A business with no reviews is new
          rather than badly rated, and marking up a score we do not have is the
          one thing this codebase refuses everywhere else.
        - NOTHING AT ALL FOR A SAMPLE BUSINESS. The seeded profiles carry seeded
          reviews. Labelling them on the page is enough for a reader; submitting
          them to a search engine as a real business with a real score is
          fabricated inventory, which is a different and worse thing. The Worker
          drops the node and asks for noindex on the same condition.
      */}
      {!o.is_sample && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: jsonLd((() => {
              const url = absoluteUrl(`/p/${encodeURIComponent(slug ?? '')}`);
              // Their own face or their own work, in the Worker's order of
              // preference. Neither means no `image` key at all.
              const imageKey = o.avatar_key ?? photos[0]?.r2_key ?? null;
              return {
                '@context': 'https://schema.org',
                '@type': 'LocalBusiness',
                '@id': url,
                name: o.business_name,
                url,
                address: {
                  '@type': 'PostalAddress',
                  addressLocality: metro.name,
                  addressRegion: metro.state,
                  addressCountry: o.country || metro.country,
                },
                // The neighbourhoods this business has actually listed, which
                // is the same list "Where they work" prints below, qualified by
                // the state so each one is a place rather than a bare word. No
                // radius: a circle drawn round a van would be a claim about
                // coverage nobody here has made.
                areaServed: areas.map((a) => ({
                  '@type': 'Place', name: `${a}, ${metro.state}`,
                })),
                ...(imageKey ? { image: absoluteUrl(photoUrl(imageKey)) } : {}),
                ...(o.tagline ? { description: o.tagline } : {}),
                ...(o.trade ? { category: sentence(o.trade) } : {}),
                ...(rating.count > 0 && rating.average != null
                  ? {
                    aggregateRating: {
                      '@type': 'AggregateRating',
                      ratingValue: rating.average,
                      reviewCount: rating.count,
                      bestRating: 5,
                      worstRating: 1,
                    },
                  }
                  : {}),
              };
            })()),
          }}
        />
      )}

      {/*
        THE PAGE IS STILL ONE COLUMN. IT IS A SECOND COLUMN ONLY WHERE THERE IS
        ROOM FOR ONE BESIDE IT.

        Below 1100px this wrapper is an ordinary block and the measure, the
        order and the appearance of everything inside it are exactly what they
        were. Above it the wrapper becomes a two-track grid and the rail comes
        out of hiding. Nothing moves between the two: the rail is additional to
        the openings block, never instead of it, so a narrow window is not a
        window with the action removed from it.
      */}
      <div className="pro-shell">
      <div className="pro-main">

      <header className="pro-head">
        {/* The face first. Somebody is deciding whether to open their door;
            a photograph of the person does more than any copy on the page. */}
        <div className="pro-avatar">
          {o.avatar_key
            ? <img src={`/api/public/photo/${o.avatar_key}`} alt="" />
            : <span aria-hidden="true">{o.business_name.slice(0, 1)}</span>}
        </div>

        <div className="pro-id">
          <h1>{o.business_name}</h1>
          {rating.count > 0 ? (
            <div className="pro-score">
              <strong>{rating.label}</strong>
              <span className="pro-num">{rating.average?.toFixed(1)}</span>
              <Stars n={Math.round(rating.average ?? 0)} />
              {/* "(12)" on its own is a number with no noun. The word is
                  supplied for the read-aloud version rather than printed,
                  because the bracket beside a row of stars already says it
                  to anybody looking at it. */}
              <span className="faint">
                ({rating.count}<span className="sr-only"> reviews</span>)
              </span>
            </div>
          ) : (
            // Said in words rather than as five grey stars. A new business is
            // not a bad one, and empty stars read like a bad one.
            <div className="pro-score"><span className="faint">New — no reviews yet</span></div>
          )}
          {o.tagline && <p className="pro-tagline">{o.tagline}</p>}

          {/*
            THE TWO FACTS THAT DECIDE WHETHER TO READ ANY FURTHER, BESIDE THE
            NAME RATHER THAN FOUR SCREENS BELOW IT.

            What they do, and whether they come anywhere near you. The reference
            puts a trade and a city here and it is the right instinct: a person
            who has landed on a locksmith while looking for a mobile mechanic,
            or on a business that only works the far side of the county, wants
            to know inside one second and not after the reviews.

            Both come straight off the payload, and each is drawn only if it is
            there — `trade` is nullable and a business that has set no service
            area has an empty list. Three names and a count, rather than all of
            them, because this is a line and not the section: the full list is
            one click down and this says so.
          */}
          {(o.trade || areas.length > 0) && (
            <p className="pro-head-facts">
              {o.trade && <span className="pro-head-trade">{sentence(o.trade)}</span>}
              {areas.length > 0 && (
                <span>
                  Works {areas.slice(0, 3).join(', ')}
                  {areas.length > 3 && ` and ${areas.length - 3} more`}
                  {' '}<a href="#pro-where">where they go</a>
                </span>
              )}
            </p>
          )}

          {/*
            Sharing a business is how most of these pages are actually found:
            somebody's neighbour asks who did the drive, and the answer is a
            link. The control sits with the name because that is what is being
            passed on, and the line under it is a live region so the reader who
            cannot see a share sheet open still learns which of the two things
            happened.
          */}
          <p className="pro-share">
            <button type="button" className="btn quiet sm" onClick={() => void share()}>
              Share this business
            </button>
          </p>
          <p className="pro-share-said" role="status">{shareMsg}</p>
        </div>
      </header>

      {/*
        Five words under the head, and a way down to each of them. The page runs
        long on a business with a full profile — a dozen reviews with photographs
        is several screens — and until now the only way to the credentials at the
        bottom was to scroll past all of it.

        Ordinary fragment links, not scripted scrolling: the browser's own
        handling moves focus to the target as well as the viewport, which is the
        half that a hand-rolled `scrollIntoView` invariably drops, and it leaves
        the address bar carrying a link straight to the section.
      */}
      {sections.length > 0 && (
        <nav className="pro-nav" aria-label="On this page">
          <ul>
            {sections.map((s) => (
              <li key={s.id}><a href={`#${s.id}`}>{s.label}</a></li>
            ))}
          </ul>
        </nav>
      )}

      {/*
        THEIR OWN OPEN APPOINTMENTS, ON THEIR OWN PAGE.

        This block used to be a single button that said "See their open
        appointments" and went to the whole trade — every business in the city
        doing this work, with this one somewhere in it. That was the most
        jarring thing on the page: a visitor who had just read four reviews of
        one person was handed a directory. There is no route for one
        business's openings, but there did not need to be: the public map
        carries every open hour in the city and each row says whose it is, so
        the page filters it to this business and lays the cards out here.

        They are the same `SlotCard` the front page and the trade page render,
        for the reason set out in that component: an appointment must not look
        like a different object depending on where you found it. The link to
        the trade stays, demoted to what it always was — a way to compare this
        business against the others rather than the answer to "when can they
        come".
      */}
      <section className="pro-cta" id="pro-openings" tabIndex={-1} ref={setCtaEl}>
        {mine === null ? (
          /* The map has not answered, or never will. Falling back to the link
             this page has always had, rather than to a spinner that might
             never resolve or an emptiness that would be a lie. */
          <Link className="btn block" to={tradeTo}>{tradeLabel}</Link>
        ) : mine.length === 0 ? (
          <>
            <h2 className="pro-cta-h">Nothing open right now</h2>
            <p className="pro-cta-p">
              {o.business_name} has no free hours listed at the moment. An
              opening appears when a job cancels or a day does not fill, so it
              arrives without warning — so the way to reach them for a
              particular day is to write to them, below.
            </p>
            {/* Demoted to a link here, where it used to be the only button in
                the block. Somebody reading this business's page wants this
                business; the rest of the trade is the second answer, and the
                first one now exists. */}
            <p className="pro-cta-else"><Link to={tradeTo}>{tradeLabel}</Link></p>
          </>
        ) : (
          <>
            <h2 className="pro-cta-h">{openLabel}</h2>
            {/* The payment half of this comes from PaymentState.tsx rather
                than being written again here. It had been written again here,
                and in Trade.tsx, each in slightly different words — which is
                the arrangement that put four contradictory claims about paying
                on the site in the first place. */}
            <p className="pro-cta-p">
              Hours {o.business_name} has free, at the prices they listed.
              {' '}{PAY_TODAY_SHORT}
            </p>
            {/*
              ONE HEADING PER DAY, RATHER THAN ONE LIST OF EVERYTHING.

              The day is the unit a person books in — they are free on Saturday
              or they are not — and an ungrouped run of cards makes them read
              every "when" line to find that out. The dates are printed on the
              business's own clock and the note under the block says so, for the
              same reason the business-hours block says it.

              A <h3> under the <h2> above, so somebody moving by headings gets
              the days as children of "N appointments open" rather than as seven
              more siblings of everything else on the page.
            */}
            {openDays.map((d) => (
              <div className="pro-day" key={d.key}>
                <h3 className="pro-day-h">{d.heading}</h3>
                <div className="slot-grid">
                  {/* `onTheirPage` matters for exactly one kind of card: a
                      sample listing, whose action is a link to the business's
                      own page — which is this page. See SlotCard for why that
                      card has no action rather than a link back to where the
                      reader already is. A real listing is unaffected and still
                      says Book. */}
                  {d.slots.map((s) => (
                    <SlotCard key={s.gap_id} slot={s} onTheirPage
                      area={areaName.get(s.area_slug) ?? null} />
                  ))}
                </div>
              </div>
            ))}
            <p className="pro-plain pro-svc-note">
              Days and times are {o.business_name}'s own ({zoneLabel(o.timezone)}).
              These are the hours they have actually listed as free — not an
              estimate of when they might be, and not a promise that anything
              else in the week is available.
            </p>
            {mine.length > openLimit && (
              <div className="more">
                <button className="btn quiet" type="button"
                  onClick={() => setOpenLimit((n) => n + OPEN_PAGE)}>
                  Show {Math.min(OPEN_PAGE, mine.length - openLimit)} more
                </button>
              </div>
            )}
            {o.trade && (
              <p className="pro-cta-else">
                <Link to={tradeHref(o.trade)}>
                  Compare with everyone else doing {o.trade}
                </Link>
              </p>
            )}
          </>
        )}
        {/*
          THE TWO WAYS TO REACH A BUSINESS THAT HAS NOTHING LISTED.

          Booking an existing opening used to be the only one, which meant a
          customer who wanted something next Tuesday had no way to ask for it —
          the page could show them a business, a score and a list of work, and
          then had nothing for them to do about it. Both of these open the same
          conversation a booking opens, at the same address, so what follows is
          a page the rest of the site already knows how to render.

          Two buttons rather than one because they are genuinely different
          questions: one is "can you do this at all", the other is "what would
          this cost", and the second is answered with a price and a time the
          customer can accept. Neither holds a slot and both say so.
        */}
        <div className="pro-ask">
          <p className="pro-ask-p">
            {openCount > 0
              ? `None of these suit? Write to ${o.business_name} about another `
                + 'day, or describe the job and ask what it would cost.'
              : `You can still write to ${o.business_name}. Ask about another `
                + 'day, or describe the job and ask what it would cost.'}
          </p>
          <div className="pro-ask-row">
            <button type="button" className="btn"
              onClick={() => setEnquiry('message')}>
              Message {o.business_name}
            </button>
            <button type="button" className="btn quiet"
              onClick={() => setEnquiry('quote')}>
              Ask for a quote
            </button>
          </div>
        </div>

        <p className="faint" style={{ margin: '10px 0 0' }}>
          Messages go through the app. No phone numbers are exchanged.
        </p>
      </section>

      {bio && (
        <section className="pro-block" id="pro-about" tabIndex={-1}>
          <h2>About</h2>
          <p className="pro-bio">{bio}</p>
          {long && (
            <button type="button" className="linkish"
              onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Read less' : '…Read more'}
            </button>
          )}
        </section>
      )}

      <section className="pro-block">
        <div className="pro-cols">
          <div>
            <h2>Overview</h2>
            {/*
              THE OVERVIEW IS NOW TWO LISTS, BECAUSE IT WAS TWO KINDS OF FACT
              PRETENDING TO BE ONE.

              It used to be a single column of green ticks: hired N times,
              background checked, solo operator, N years in business. Four ticks
              in a row read as four things somebody confirmed — that is the
              entire visual argument a tick makes — and only the first of them
              is counted by anything. The rest are typed into a settings form by
              the person they describe, and one of them, the background check,
              was a platform endorsement this site has no right to make at all.

              So: the counted fact keeps its tick, under a heading that says who
              counted it. The self-reported facts are a plain list under a
              heading that says, in words, whose claim they are. Neither is
              hidden — a customer genuinely wants to know that somebody has been
              at this eleven years — and neither is dressed as the other.

              "Background checked" is gone from here entirely. It survives, once,
              in the Credentials section at the bottom, where there is room to
              say what it is and is not. A tick in a scan list has no room to say
              anything.
            */}
            {o.hired_count > 0 && (
              <>
                <h3 className="pro-sub">Counted by Round The Way</h3>
                <ul className="pro-list">
                  <li>
                    <Icon name="tick" size={17} />
                    {' '}Hired {o.hired_count}{' '}
                    {o.hired_count === 1 ? 'time' : 'times'} through this site
                  </li>
                </ul>
              </>
            )}

            {/*
              Unconditional, because `employees` always has a value — every
              business is at least one person — so this heading never appears
              over an empty list. The two year figures are nullable and each
              draws only when it is there.
            */}
            <h3 className="pro-sub">What {o.business_name} says about themselves</h3>
            <ul className="pro-said">
              <li>{o.employees === 1 ? 'Solo operator' : `${o.employees} employees`}</li>
              {o.years_in_business != null && (
                <li>{o.years_in_business}{' '}
                  {o.years_in_business === 1 ? 'year' : 'years'} in business</li>
              )}
              {o.years_experience != null && (
                <li>{o.years_experience}{' '}
                  {o.years_experience === 1 ? 'year' : 'years'} in the trade</li>
              )}
            </ul>
            <p className="pro-plain pro-svc-note">
              Self-reported. {o.business_name} entered these themselves and
              Round The Way has not checked any of them.
            </p>

            {o.payment_methods && (
              <>
                <h3 className="pro-sub">Payment methods</h3>
                {/* Also self-reported, and worth saying so for a different
                    reason from the years above: this one the reader is going to
                    act on at the kerb with a wallet in their hand. "They say
                    they take cash" and "they take cash" are the same sentence
                    right up until somebody turns up with only cash. */}
                <p className="pro-plain">
                  {o.business_name} says they take {o.payment_methods}. Worth
                  confirming with them before the day — this is their own
                  description and nobody here has tested it.
                </p>
              </>
            )}
          </div>

          <div>
            {(o.social_instagram || o.social_facebook || o.social_tiktok) && (
              <>
                <h2>Social media</h2>
                <p className="pro-plain pro-social">
                  {[
                    o.social_facebook && ['Facebook', o.social_facebook],
                    o.social_instagram && ['Instagram', o.social_instagram],
                    o.social_tiktok && ['TikTok', o.social_tiktok],
                  ].filter(Boolean).map((pair, i) => {
                    const [name, href] = pair as [string, string];
                    return (
                      <span key={name}>
                        {i > 0 && ', '}
                        <a href={href} target="_blank" rel="noreferrer noopener">{name}</a>
                      </span>
                    );
                  })}
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="pro-block" id="pro-services" tabIndex={-1}>
        <h2>Services offered</h2>
        {/*
          The named work, all of it. This heading carried nothing but the travel
          direction, which is not a service — somebody reading "Services offered
          / I travel to my customers" has been told how the business gets to
          them and nothing about what happens when it arrives — and then, for a
          while, only the services that happened to have a free hour against
          them, which changed hour to hour and was not what the heading claimed.

          A price appears against a service the business has an opening for
          right now, because that is where a formatted price exists; the rest
          carry how long the work takes, which every row does. The note says
          which is which so a service without a figure is not read as a service
          without a price.
        */}
        {services.length > 0 && (
          <>
            <ul className="pro-ticks">
              {services.map((s) => {
                const price = priceByService.get(s.id) ?? null;
                return (
                  <li key={s.id}>
                    {s.name}{' '}
                    <span className="faint">
                      {durationLabel(s.duration_seconds)}
                      {price ? ` · ${price}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="pro-plain pro-svc-note">
              {priceByService.size > 0
                ? `Everything ${o.business_name} does, with how long they set `
                  + 'aside for it. A price is shown where they have an opening '
                  + 'for that work at the moment; the others are priced when '
                  + 'they list one.'
                : `Everything ${o.business_name} does, with how long they set `
                  + 'aside for it. Prices appear against these when they list '
                  + 'an opening.'}
            </p>
          </>
        )}
        <h3 className="pro-sub">Work location</h3>
        <ul className="pro-ticks">
          {(WORK_LOCATION[o.work_location] ?? WORK_LOCATION.i_travel!).map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </section>

      {/*
        WHERE THEY GO, AND — THE HALF EVERY DIRECTORY LEAVES OUT — WHERE THEY
        DO NOT.

        This is the module that replaces the reference's trust furniture, and it
        earns the place because on a site of vans it is the question. A badge
        tells a customer that somebody, somewhere, once checked a name against a
        database. This tells them whether the person can physically reach their
        street, which is the thing that actually decides the booking.

        The three parts, and why each is here:

          THE DIRECTION, IN A SENTENCE. `work_location` is one of three enum
          values and the tick list above prints the operator's own answer to
          their own form. This prints what that answer means for the reader.

          THE PATCH, IN FULL. `areas` is every active service area the business
          has drawn, by name — not a metro, not a radius, not "Los Angeles and
          surrounding areas". The full list rather than the head of it, because
          this is the section the line beside their name points at.

          WHAT IS NOT ON THE LIST. Said out loud, and this is the whole point of
          the block. A neighbourhood missing from a service area list is not a
          neighbourhood the business refuses — it is one they have not said
          anything about, and those are different, and a reader looking for
          their own street in a list has no way to tell which they have found.
          Every directory silently lets the reader assume the generous reading.
          A business that has drawn no areas at all gets the same treatment: an
          empty list is "they have not said", never "they go everywhere".
      */}
      <section className="pro-block" id="pro-where" tabIndex={-1}>
        <h2>Where {o.business_name} works</h2>
        <p className="pro-plain">
          {TRAVEL_PROSE[o.work_location] ?? TRAVEL_PROSE.i_travel!}
        </p>

        {areas.length > 0 ? (
          <>
            <h3 className="pro-sub">
              {areas.length === 1
                ? 'The area they have listed'
                : `The ${areas.length} areas they have listed`}
            </h3>
            <p className="pro-plain">{areas.join(', ')}</p>
            <p className="pro-plain pro-svc-note">
              These are the neighbourhoods {o.business_name} has drawn on their
              own map, so it is where their openings appear. It is not a limit
              anyone enforces and it is not a refusal of anywhere else: a street
              that is not on this list is somewhere they have simply not said
              either way. If yours is not here, ask them before you book.
            </p>
          </>
        ) : (
          <p className="pro-plain pro-svc-note">
            {o.business_name} has not listed any neighbourhoods yet, so there is
            nothing here to tell you how far they will drive. Ask them where they
            go before you book — the message button above reaches them without an
            account.
          </p>
        )}
      </section>

      {/*
        BUSINESS HOURS, in the business's own time.

        Only when they have said. An operator who has never set hours sends an
        empty array, and an empty array is "they have not said" rather than
        "closed every day" — see the note at the top of this file. Every weekday
        they did not set is named as closed, though, because a missing Sunday is
        read as an open one.
      */}
      {data.working_hours.length > 0 && (
        <section className="pro-block">
          <h2>Business hours</h2>
          {/*
            Two days, then the rest on request. Printing the week in full made
            this the tallest block on the page for the least-read fact on it,
            and on a phone it pushed the photographs and the reviews — the two
            things a reader is here for — a screen and a half further down. The
            button stays in the document in both states rather than being
            swapped for a "show less" elsewhere, so a keyboard is never left
            standing on an element that has just been removed.
          */}
          <dl className="pro-hours">
            {(hoursOpen ? week : week.slice(0, HOURS_SHUT)).map(({ weekday, bands }) => (
              <div className={`pro-hour${bands.length === 0 ? ' shut' : ''}`}
                key={weekday}>
                <dt>{DAY_NAMES[weekday]}</dt>
                <dd>
                  {bands.length === 0
                    ? 'Closed'
                    : bands
                      .map((b) => `${wallClock(b.start_minute)}–${wallClock(b.end_minute)}`)
                      .join(', ')}
                </dd>
              </div>
            ))}
          </dl>
          <p className="pro-hours-more">
            <button type="button" className="linkish" aria-expanded={hoursOpen}
              onClick={() => setHoursOpen(!hoursOpen)}>
              {hoursOpen ? 'Show fewer days' : 'Read more — the whole week'}
            </button>
          </p>
          <p className="pro-plain pro-svc-note">
            Shown in {o.business_name}'s own time ({zoneLabel(o.timezone)}), not
            yours. These are the hours they work; an opening only appears inside
            them when a job cancels or a day does not fill.
          </p>
        </section>
      )}

      {photos.length > 0 && (
        <section className="pro-block" id="pro-photos" tabIndex={-1}>
          <h2>Photos <span className="faint">({photos.length})</span></h2>
          <div className="pro-photos">
            {photos.map((p) => (
              // The image is the whole of this link, so its alt text is the
              // whole of the link's name. An empty alt — which is what an
              // uncaptioned photo used to get — left a link announced as
              // nothing at all, and a gallery of eight of them as eight
              // nameless links in a row. Most of these have no caption,
              // because captions are optional on the operator's side.
              <a key={p.id} href={`/api/public/photo/${p.r2_key}`}
                target="_blank" rel="noreferrer" className="pro-photo">
                <img src={`/api/public/photo/${p.r2_key}`}
                  alt={p.caption ?? `Work by ${o.business_name}`} loading="lazy" />
              </a>
            ))}
          </div>
        </section>
      )}

      {/*
        WHAT A VAN NEEDS AT THE KERB — AS QUESTIONS, BECAUSE THE SITE HOLDS NO
        ANSWERS.

        See ON_SITE_QUESTIONS above for why this is five questions rather than
        five facts: there is no column anywhere in this product recording
        whether a business needs an outside tap, and writing one in from the
        trade name would be inventing a fact about a person.

        It is nonetheless the most useful block on the page for this particular
        product, which is why it is here rather than left out. Everything on a
        fixed-premises marketplace happens at the pro's address, where the pro
        has already solved parking and water and power. Every job here happens
        at a stranger's kerb, where nobody has solved any of it, and the failure
        mode is not a bad review — it is a van that drives an hour and turns
        round. Putting the questions in front of the customer before they book
        is the cheapest fix available to a page.

        Unconditional. Unlike every other block here it depends on no row, so
        there is no state in which it is empty or misleading; it is the same
        five questions for a locksmith and a dog groomer because they are the
        five things a kerb either has or has not got.
      */}
      <section className="pro-block" id="pro-onsite" tabIndex={-1}>
        <h2>Before they arrive</h2>
        <p className="pro-plain">
          {o.business_name} works out of a vehicle, so the job happens wherever
          you are and whatever is there is what they have to work with. These
          are worth settling in a message first — none of them is on this page
          because Round The Way does not ask businesses to record them, so the
          only person who can answer is {o.business_name}, and the only person
          who knows your kerb is you.
        </p>
        <ul className="pro-ask-list">
          {ON_SITE_QUESTIONS.map((qn) => <li key={qn}>{qn}</li>)}
        </ul>
        <p className="pro-plain pro-svc-note">
          Ask any of these with the message button above. It costs nothing and
          does not book anything.
        </p>
      </section>

      <section className="pro-block" id="pro-reviews" tabIndex={-1}>
        <h2>Reviews</h2>

        {rating.count === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No reviews yet. Only somebody who booked here and had the work
            done can leave one, so they take a while to arrive — and they mean
            something when they do.
          </p>
        ) : (
          <>
            <div className="pro-rating">
              <div className="pro-rating-big">
                <strong>{rating.average?.toFixed(1)}</strong>
                <Stars n={Math.round(rating.average ?? 0)} />
                <span className="faint">{rating.count} reviews</span>
              </div>
              <div className="pro-bars">
                {([5, 4, 3, 2, 1] as const).map((star) => {
                  const n = rating.distribution[star] ?? 0;
                  const pct = rating.count ? Math.round((n / rating.count) * 100) : 0;
                  return (
                    // "5 … 62%" is two bare numbers read one after the other,
                    // and the bar between them that says what they mean to
                    // each other is a coloured rectangle. The two missing
                    // nouns are supplied for the read-aloud version only.
                    <div key={star} className="pro-bar">
                      <span>{star}<span className="sr-only"> stars</span></span>
                      <span className="pro-bar-track" aria-hidden="true">
                        <span className="pro-bar-fill" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="faint">
                        {pct}%<span className="sr-only"> of reviews</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="pro-tools">
              <label className="pro-search">
                <Icon name="search" size={16} color="var(--muted)" />
                <input value={q} onChange={(e) => setQ(e.target.value)}
                  placeholder="Search reviews" aria-label="Search reviews" />
              </label>
              <select value={sort} onChange={(e) => setSort(e.target.value)}
                aria-label="Sort reviews">
                {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>

            {mentions.length > 0 && (
              <div className="pro-mentions">
                <span className="pro-mentions-label">Read reviews that mention:</span>
                <div className="pro-chips">
                  {mentions.map((m) => (
                    <button key={m.word} type="button"
                      className={`pro-chip${q === m.word ? ' on' : ''}`}
                      onClick={() => setQ(q === m.word ? '' : m.word)}>
                      {m.word} · {m.n}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="pro-reviews">
              {shown.length === 0 && (
                <p className="muted">No reviews mention “{q}”.</p>
              )}
              {shown.map((r) => {
                const isOpen = open.has(r.id);
                const cut = (r.body ?? '').length > 320;
                return (
                  <article key={r.id} className="pro-review">
                    <div className="pro-review-top">
                      <span className="pro-review-who">
                        <span className="pro-review-av" aria-hidden="true">
                          {r.author_name.slice(0, 1)}
                        </span>
                        <strong>{r.author_name}</strong>
                      </span>
                      <span className="faint">{monthYear(r.created_at)}</span>
                    </div>

                    <div className="pro-review-meta">
                      <Stars n={r.rating} />
                      {/* The equivalent of their "Hired on Thumbtack". It is
                          not decoration: on this site it is the whole reason
                          a review can be trusted, because nothing else can
                          leave one. */}
                      <span className="pro-verified">
                        <Icon name="tick" size={13} /> Booked on Round The Way
                      </span>
                    </div>

                    {r.body && (
                      <p className="pro-review-body">
                        {cut && !isOpen ? `${r.body.slice(0, 320)}…` : r.body}
                        {cut && (
                          // aria-expanded, because the button does not
                          // navigate — it grows the paragraph it sits in,
                          // and without the state said out loud the only
                          // signal that anything happened is text a screen
                          // reader user has already scrolled past.
                          <button type="button" className="linkish"
                            aria-expanded={isOpen}
                            onClick={() => setOpen((prev) => {
                              const next = new Set(prev);
                              if (next.has(r.id)) next.delete(r.id); else next.add(r.id);
                              return next;
                            })}>
                            {isOpen ? ' Read less' : ' …Read more'}
                          </button>
                        )}
                      </p>
                    )}

                    {r.photos && r.photos.length > 0 && (
                      <div className="pro-review-photos">
                        {r.photos.map((id) => (
                          // Same as the gallery above: the image is the only
                          // thing in the link, so an empty alt made the link
                          // nameless. A review photo has no caption to
                          // borrow, so the name says whose review it came
                          // from — which is the fact that makes one of these
                          // worth opening rather than the one beside it.
                          <a key={id} className="pro-review-photo"
                            href={`/api/public/review-photo/${id}`}
                            target="_blank" rel="noreferrer">
                            <img src={`/api/public/review-photo/${id}`}
                              alt={`Photo from ${r.author_name}'s review`}
                              loading="lazy" />
                          </a>
                        ))}
                      </div>
                    )}

                    {r.details && (
                      <p className="pro-review-details">Details: {r.details}</p>
                    )}

                    {r.reply && (
                      <div className="pro-reply">
                        <strong>Response from {o.business_name}</strong>
                        <p>{r.reply}</p>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </>
        )}
      </section>

      <section className="pro-block" id="pro-credentials" tabIndex={-1}>
        <h2>Credentials</h2>
        {o.background_checked_at ? (
          <>
            <div className="pro-cred">
              {/* The label carries the qualification, rather than leaving it to
                  the paragraph underneath. A reader scanning headings takes
                  "Background check" as a heading this site is standing behind,
                  and by the time they reach the small print they have already
                  decided. Two words in the label cost nothing and cannot be
                  scrolled past. */}
              <strong>Background check — self-reported</strong>
              <span>{o.background_check_name}</span>
              {o.background_check_provider && (
                <span className="faint">Checked by {o.background_check_provider}</span>
              )}
            </div>
            {/*
              /covered and /safety both say in as many words that this site does
              not verify licences, insurance or background checks. This block
              printed the business's own record of one as a bare fact, which is
              the page that reads as us vouching for it — and it is the page a
              customer is on at the moment they decide. SlotCard says the same
              thing about the chip it draws for this; it is said here too rather
              than only in the small print two pages away.
            */}
            <p className="pro-plain pro-svc-note">
              This is what {o.business_name} has recorded about themselves.
              Round The Way does not run the check and does not verify it — see{' '}
              <Link to="/covered">what is covered</Link>.
            </p>
          </>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            This business has not recorded a background check. Round The Way does not
            run one either way — see <Link to="/covered">what is covered</Link>.
          </p>
        )}

        {/*
          THE ABSENCE THAT MATTERS MOST, WRITTEN DOWN RATHER THAN LEFT BLANK.

          The reference has a licences module here, with a number and a state
          board behind it. This site has no licence column at all — nothing in
          the profile payload carries one, nothing collects one, and no part of
          this product has ever checked a trade licence, a certificate of
          insurance or a bond.

          The tempting thing is to render nothing, on the grounds that we are
          not claiming anything. That is wrong, and it is wrong in the reader's
          direction: this is the section of a profile a customer opens
          specifically to find out about licensing, and a section that goes
          quiet at that exact point is read as "nothing to report" rather than
          as "we do not know". So the absence is stated in the same size type as
          everything else, and it points at the one place that can actually
          answer — the issuing board's own register, which is public and free.

          This paragraph is unconditional, and is deliberately outside the
          background-check branch above: it is just as true of a business that
          has recorded a check as of one that has not, and a reader who sees a
          check recorded is if anything more likely to assume the licence was
          seen too.
        */}
        <h3 className="pro-sub">Licences and insurance</h3>
        <p className="pro-plain pro-svc-note">
          Round The Way holds nothing about either. We do not collect licence
          numbers, we do not see certificates of insurance, and we verify
          neither — for this business or any other. Where California requires a
          licence for this trade it is between {o.business_name} and the issuing
          board, and that board's public register is the place to check it. Ask
          them directly for a licence number and an insurer, and check what you
          are told. See <Link to="/covered">what is covered</Link>.
        </p>
      </section>

      {faqs.length > 0 && (
        <section className="pro-block">
          <h2>FAQs</h2>
          <div className="pro-faqs">
            {faqs.map((f) => (
              <div key={f.id} className="pro-faq">
                <h3>{f.question}</h3>
                <p>{f.answer}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/*
        WHERE ELSE TO LOOK, AT THE POINT SOMEBODY HAS DECIDED IT IS NOT HERE.

        Somebody who has read to the bottom of a profile has either made up
        their mind or ruled the business out, and the second of those used to
        end at the last FAQ with nothing to do. These are the rows the Worker
        sends: real businesses in the same trade whose patch overlaps this one's,
        with the business being read excluded server-side.

        Nothing is drawn that is not in the row. A business nobody has reviewed
        has `rating: null`, which is not a low score and is not five empty
        stars, so the whole score line is left out for it — the same rule the
        head of this page and the slot cards follow. An empty array is not "no
        similar businesses found", it is nothing at all: this trade has one page
        in it, and saying so tells the reader nothing they can use.
      */}
      {shownAlts.length > 0 && (
        <section className="pro-block pro-alts-block">
          <h2>{o.trade ? `Other businesses doing ${o.trade}` : 'Other businesses'}</h2>
          <ul className="pro-alts">
            {shownAlts.map((b) => (
              <li key={b.profile_slug}>
                <Link className="pro-alt" to={`/p/${encodeURIComponent(b.profile_slug)}`}>
                  <span className="pro-alt-av" aria-hidden="true">
                    {b.avatar_key
                      ? <img src={`/api/public/photo/${b.avatar_key}`} alt="" loading="lazy" />
                      : b.business_name.slice(0, 1)}
                  </span>
                  <span className="pro-alt-body">
                    <span className="pro-alt-name">
                      {b.business_name}
                      {/* Same wording and the same two read-aloud words as the
                          slot cards, because it is the same claim: a seeded
                          business must not be passed off as a real one. */}
                      {b.is_sample && (
                        <span className="sample">
                          <span className="sr-only"> </span>Sample
                          <span className="sr-only"> listing</span>
                        </span>
                      )}
                    </span>
                    {b.rating != null && b.review_count > 0 && (
                      <span className="pro-alt-score">
                        <span className="pro-num">{b.rating.toFixed(1)}</span>
                        <Stars n={Math.round(b.rating)} />
                        <span className="faint">
                          ({b.review_count}<span className="sr-only"> reviews</span>)
                        </span>
                      </span>
                    )}
                    {b.tagline && <span className="pro-alt-tag">{b.tagline}</span>}
                    {(b.areas.length > 0 || b.years_in_business != null) && (
                      <span className="pro-alt-facts">
                        {[
                          b.years_in_business != null
                            ? `${b.years_in_business} years in business` : null,
                          b.areas.length > 0 ? b.areas.join(', ') : null,
                        ].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          {/* Offered only when the payload came back full, because a shorter
              array is the server saying it had no more to send — and a "see
              all" that fetches, returns the same three and leaves the reader
              looking for what changed is worse than no button. */}
          {data.similar.length >= SIMILAR_IN_PAYLOAD && (
            <p className="pro-alts-all">
              {/* `aria-busy` while it fetches, not `disabled`. Disabling the
                  button a person has just pressed blurs it, and the keyboard
                  they were using is put back at the top of the document — so
                  the one control on the page that takes a moment was also the
                  one that lost their place. The handler ignores a second press
                  instead. */}
              <button type="button" className="btn quiet sm" aria-expanded={altsOpen}
                aria-busy={altsBusy} onClick={() => void seeAllAlts()}>
                {altsBusy ? 'Loading…' : altsOpen ? 'Show fewer' : 'See all'}
              </button>
            </p>
          )}
          {altsErr && <p className="muted" role="status">{altsErr}</p>}
        </section>
      )}

      </div>{/* .pro-main */}

      {/*
        THE ACTION, KEPT ON SCREEN.

        A complementary landmark rather than a second copy of the openings
        block: it carries the count and one button that goes to the block, and
        the appointments themselves stay where they are, in a column wide enough
        to lay them out. It comes after the content in the document on purpose —
        a reader going through the page in order has already been given this
        action at the top of it, and the landmark and its name are how they get
        back to it without hunting.
      */}
      <aside className="pro-rail" aria-label={`Contacting ${o.business_name}`}>
        <div className="pro-rail-card">
          {mine !== null && (
            <p className="pro-rail-h">
              {openCount === 0 ? 'Nothing open right now' : openLabel}
            </p>
          )}
          {/* The strongest thing this business can offer, first: an hour they
              have actually listed if there is one, and otherwise the message
              that no longer depends on there being one. */}
          {openCount > 0 ? (
            <a className="btn block" href="#pro-openings">See the openings</a>
          ) : (
            <button type="button" className="btn block"
              onClick={() => setEnquiry('message')}>
              Message {o.business_name}
            </button>
          )}
          <button type="button" className="btn quiet block"
            onClick={() => setEnquiry('quote')}>
            Ask for a quote
          </button>
        </div>
      </aside>

      </div>{/* .pro-shell */}

      {/*
        THE SAME ACTION ACROSS THE BOTTOM OF A PHONE.

        One button and nothing else — a bar that carries a second choice is a
        bar that has to be read, and this one is meant to be hit. It is an
        ordinary element at the end of the document with no focus handling of
        any kind on it, so it is reached by tabbing to the end and left by
        tabbing on: there is nothing here to trap anybody. The height it covers
        is given back as padding at the foot of the page, so the last of the
        content and the footer under it can still be scrolled clear of the bar.
      */}
      <div className={`pro-dock${barOn ? ' on' : ''}`}>
        {openCount > 0 ? (
          <a className="btn block" href="#pro-openings">
            {openCount === 1 ? 'See the open appointment' : `See the ${openCount} open appointments`}
          </a>
        ) : (
          // Still one button. A business with nothing listed used to be a bar
          // pointing at the rest of the trade, which is the one thing somebody
          // on this particular page has already decided against.
          <button type="button" className="btn block"
            onClick={() => setEnquiry('message')}>
            Message {o.business_name}
          </button>
        )}
      </div>

      {/* Rendered whether or not a dialog is up, so that what has been typed
          into it survives the dialog being closed by accident. */}
      <Enquiry slug={slug ?? ''} businessName={o.business_name}
        kind={enquiry} onClose={() => setEnquiry(null)} />
    </PublicPage>
  );
}
