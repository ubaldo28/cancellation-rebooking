import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api, durationLabel, sentence,
  type MapArea, type PublicProfileResponse, type PublicSlot, type Review,
} from '../api';
import { ErrorNote, Icon, Spinner } from '../components/ui';
import Crumbs from '../components/Crumbs';
import PublicPage from '../components/PublicPage';
import SlotCard from '../components/SlotCard';
import { DAY_NAMES } from '../components/WorkingHours';
import '../styles-profile.css';
import { useDocumentTitle } from '../lib/title';

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

/** How many of a business's openings are laid out before asking for more. */
const OPEN_PAGE = 6;

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

/**
 * Five glyphs, two colours, one sentence.
 *
 * The `aria-label` was already here and was doing nothing. ARIA forbids naming
 * a plain <span> — it has no role that accepts a name — so the label was
 * dropped on the floor and what got read was the glyphs themselves: "black
 * star black star black star white star white star", or in some voices
 * nothing at all. `role="img"` is what makes the label legal, and it collapses
 * the run into one object with one name, which is what it already looks like
 * to everybody who can see it.
 */
function Stars({ n }: { n: number }) {
  return (
    <span className="stars" role="img" aria-label={`${n} out of 5 stars`}>
      <span aria-hidden="true">
        {'★★★★★'.slice(0, n)}<span className="stars-off">{'★★★★★'.slice(0, 5 - n)}</span>
      </span>
    </span>
  );
}

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

  useDocumentTitle(data?.operator.business_name ?? null);

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
    const seen = new Set<string>();
    return map.slots
      .filter((s) => s.profile_slug === slug)
      .filter((s) => (seen.has(s.gap_id) ? false : (seen.add(s.gap_id), true)))
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

  const { operator: o, photos, rating, mentions, faqs, areas, services } = data;
  const long = (o.bio ?? '').length > 420;
  const bio = long && !expanded ? `${o.bio!.slice(0, 420)}…` : o.bio;

  return (
    <PublicPage className="pro">
      {/* The trail is a real link out to the trade now, not a dead word.
          Somebody who arrived here from a search engine and decided this is
          not their business needs a way sideways to the others doing the
          same work, and the crumb is where every marketplace puts it.
          Crumbs prepends Slotfill itself, which is why it is not here. */}
      <Crumbs items={[
        ...(o.trade
          ? [{ label: sentence(o.trade), to: `/s/${encodeURIComponent(o.trade)}` }]
          : []),
        { label: o.business_name },
      ]} />

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
        </div>
      </header>

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
      <section className="pro-cta">
        {mine === null ? (
          /* The map has not answered, or never will. Falling back to the link
             this page has always had, rather than to a spinner that might
             never resolve or an emptiness that would be a lie. */
          o.trade ? (
            <Link className="btn block" to={`/s/${encodeURIComponent(o.trade)}`}>
              See what is open in {o.trade}
            </Link>
          ) : (
            <Link className="btn block" to="/">See what is open near you</Link>
          )
        ) : mine.length === 0 ? (
          <>
            <h2 className="pro-cta-h">Nothing open right now</h2>
            <p className="pro-cta-p">
              {o.business_name} has no free hours listed at the moment. An
              opening appears when a job cancels or a day does not fill, so it
              arrives without warning.
            </p>
            {o.trade ? (
              <Link className="btn block" to={`/s/${encodeURIComponent(o.trade)}`}>
                See what is open in {o.trade}
              </Link>
            ) : (
              <Link className="btn block" to="/">See what is open near you</Link>
            )}
          </>
        ) : (
          <>
            <h2 className="pro-cta-h">
              {mine.length === 1
                ? 'One appointment open'
                : `${mine.length} appointments open`}
            </h2>
            <p className="pro-cta-p">
              Hours {o.business_name} has free, at the prices they listed.
              Booking one holds it; nothing is paid on this site yet, so you
              settle the price with them directly.
            </p>
            <div className="slot-grid">
              {mine.slice(0, openLimit).map((s) => (
                <SlotCard key={s.gap_id} slot={s}
                  area={areaName.get(s.area_slug) ?? null} />
              ))}
            </div>
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
                <Link to={`/s/${encodeURIComponent(o.trade)}`}>
                  Compare with everyone else doing {o.trade}
                </Link>
              </p>
            )}
          </>
        )}
        <p className="faint" style={{ margin: '10px 0 0' }}>
          Messages go through the app. No phone numbers are exchanged.
        </p>
      </section>

      {bio && (
        <section className="pro-block">
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
            {/* Icon rows, not a table. Each one is a single fact somebody
                scans for, and an icon makes it findable without reading. */}
            <ul className="pro-list">
              {o.hired_count > 0 && (
                <li><Icon name="tick" size={17} /> Hired {o.hired_count} times</li>
              )}
              {o.background_checked_at && (
                <li><Icon name="tick" size={17} /> Background checked</li>
              )}
              <li>
                <Icon name="tick" size={17} />
                {o.employees === 1 ? 'Solo operator' : `${o.employees} employees`}
              </li>
              {o.years_in_business != null && (
                <li><Icon name="tick" size={17} /> {o.years_in_business} years in business</li>
              )}
              {o.years_experience != null && (
                <li><Icon name="tick" size={17} /> {o.years_experience} years in the trade</li>
              )}
            </ul>

            {areas.length > 0 && (
              <>
                <h3 className="pro-sub">Serves</h3>
                <p className="pro-plain">{areas.join(', ')}</p>
              </>
            )}

            {o.payment_methods && (
              <>
                <h3 className="pro-sub">Payment methods</h3>
                <p className="pro-plain">
                  This business accepts payments via {o.payment_methods}.
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

      <section className="pro-block">
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
          <dl className="pro-hours">
            {week.map(({ weekday, bands }) => (
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
          <p className="pro-plain pro-svc-note">
            Shown in {o.business_name}'s own time ({zoneLabel(o.timezone)}), not
            yours. These are the hours they work; an opening only appears inside
            them when a job cancels or a day does not fill.
          </p>
        </section>
      )}

      {photos.length > 0 && (
        <section className="pro-block">
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

      <section className="pro-block">
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
                        <Icon name="tick" size={13} /> Booked on Slotfill
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

      <section className="pro-block">
        <h2>Credentials</h2>
        {o.background_checked_at ? (
          <div className="pro-cred">
            <strong>Background check</strong>
            <span>{o.background_check_name}</span>
            {o.background_check_provider && (
              <span className="faint">Checked by {o.background_check_provider}</span>
            )}
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            This business has not been background checked yet.
          </p>
        )}
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
    </PublicPage>
  );
}
