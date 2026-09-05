import { photoUrl, sentence, type PublicSlot } from '../api';
import '../styles-slotcard.css';

/**
 * One open appointment, as a card in a `.slot-grid`.
 *
 * This markup lived three times over — the front page, the trade page and the
 * search results — and the three copies were already saying different things on
 * the day they were written: the front page had been given the rating, the
 * hired count, the availability marker and a line of the newest review, and the
 * other two were still the four-line version from before any of that existed.
 * An appointment must not look like a different object depending on which page
 * you found it on, so there is one card and the pages render it.
 *
 * THE RULE THIS CARD IS BUILT AROUND: nothing is invented for a business that
 * does not have it. No "New" in the space where a rating would go, no "0
 * reviews", no greyed-out stars. Every row below is conditional and the whole
 * strip disappears when none of it is there. A grid of cards is read by
 * scanning, and at scanning speed a placeholder is indistinguishable from a
 * fact.
 *
 * The stylesheet is imported here rather than by the pages, so a page gets the
 * card's appearance by rendering the card — the previous arrangement, where the
 * rules sat in the front page's sheet, is exactly why the trade page could
 * render `.slot-more` markup and have it come out unstyled.
 *
 * THE PHOTOGRAPH, AND WHY IT IS A 56px THUMBNAIL RATHER THAN A BANNER.
 * The map payload now carries `work_photo_key` and `avatar_key`, so the card
 * can finally show the thing every listing card on the reference marketplace
 * shows. It is still bound by the rule above: a business with neither key gets
 * no picture and no space reserved for one — not a grey rectangle, not a
 * camera glyph, and above all not an initial in a circle, which on a grid of
 * photographs reads as a person's face until you get close enough to see that
 * it is a letter.
 *
 * A banner across the top is what the reference uses and it is what this card
 * cannot afford. Six cards fit a laptop screen at the current height; 120px of
 * photograph makes that three, and the whole argument of this page is that you
 * can scan a city's worth of free hours at once. So the picture takes the
 * three text rows' worth of height that already exists on the left of the
 * card, spans rows 1 to 3 in a column added only when there is something to
 * put in it, and adds no height at all. `.slot-more` and `.slot-foot` keep
 * `grid-column: 1 / -1` and the slack stays in the same flexible row it was
 * in, so the Book buttons across a row are still pinned to each other.
 */

export interface SlotCardProps {
  slot: PublicSlot;
  /**
   * Whether to name the trade after the business.
   *
   * On the front page and in search results a card can be any trade at all, so
   * the name is the thing that tells you what you are looking at. On a trade
   * page every card is the same trade and the page's own heading has already
   * said which, so repeating it thirty times is noise in the one line that
   * could be carrying something else.
   */
  showTrade?: boolean;
  /**
   * The neighbourhood this opening sits in, as a person would write it —
   * "Encino", not "encino".
   *
   * WHY THIS IS A PROP AND NOT READ OFF THE ROW. Every row carries an
   * `area_slug`, and a slug is not a place name: turning "north-hollywood"
   * into "North Hollywood" here would be this component guessing at a
   * business's own words, and it would get the first "Van Nuys" it met wrong
   * as easily as it got it right. The real name is on the map payload's
   * `areas`, keyed by that slug, so the page that fetched them passes it
   * down. A page that has not got them passes nothing and the card says
   * nothing, which is the same rule everything else on it follows.
   */
  area?: string | null;
}

export default function SlotCard({ slot: s, showTrade = false, area = null }: SlotCardProps) {
  /* Everything in the strip under the business name is conditional on the
     business actually having it, and the strip itself disappears when none of
     it is there. A card that reserves a line for a rating and then fills it
     with a placeholder is how a directory ends up implying that every business
     has been graded. */
  const hasMeta = s.online || s.rating !== null
    || s.hired_count > 0 || s.background_check
    || s.years_in_business !== null;

  /* The work photo wins over the headshot, because it is the one that answers
     the question a grid of these is being scanned for — what does this person's
     work look like — and the avatar is the fallback rather than the other way
     round. Neither means no picture: see the note at the top of this file for
     why there is no placeholder standing in for one. */
  const photo = s.work_photo_key ?? s.avatar_key;

  return (
    // A plain anchor rather than <Link>: /book/:gapId is a React route, but a
    // full load of the booking page is the cheaper thing to be wrong about here
    // and it is what every page did before this component existed.
    <a href={`/book/${s.gap_id}`}
      className={`slot-card${s.online ? ' is-live' : ''}${photo ? ' has-photo' : ''}`}>
      {photo && (
        // alt="" deliberately. The image is one part of a link whose name is
        // already the service, the price, the time and the business; a photo
        // with no caption in the payload could only contribute "Work by Bright
        // Vans" to that, which lengthens what is read aloud for every card in
        // a grid of thirty and adds nothing a listener did not just hear.
        // Width and height are on the element as well as in the sheet so the
        // row does not reflow between the card drawing and the photo arriving.
        <img className="slot-photo" src={photoUrl(photo)} alt=""
          width={56} height={56} loading="lazy" decoding="async" />
      )}
      <span className="slot-svc">{s.service_name}</span>
      <span className="slot-price">{s.price}</span>
      <span className="slot-when">{s.when}</span>
      <span className="slot-biz">
        {s.business_name}{showTrade && s.trade ? ` · ${sentence(s.trade)}` : ''}
        {/* Says what it is rather than passing a seeded business off as a real
            one. The leading space and the extra word are for the read-aloud
            version: the badge is a sibling with no whitespace between it and
            the business name, so name computation ran the two together into
            "Bright VansSample", and "sample" on its own does not say sample
            what. Neither changes a pixel — the badge still reads SAMPLE. */}
        {s.is_sample && (
          <span className="sample">
            <span className="slot-sr"> </span>Sample<span className="slot-sr"> listing</span>
          </span>
        )}
      </span>

      {/* One wrapper, not three siblings: the card is a four-row grid whose
          last flexible row is what pins the footer to the bottom of every card
          in a row. Adding rows directly would put the slack in the middle of
          the card instead, and the Book buttons in a row would stop lining
          up. */}
      {(hasMeta || s.review_snippet) && (
        <span className="slot-more">
          {hasMeta && (
            <span className="slot-meta">
              {/* The one thing on this card that is about right now rather than
                  later this week, so it is the one thing wearing the accent. */}
              {s.online && <span className="slot-now">Open now</span>}

              {s.rating !== null && (
                <span className="slot-rate">
                  <span className="slot-star" aria-hidden="true">★</span>
                  {/* "Rated" as well as "out of 5", because without it the
                      strip reads as a bare run of numbers — "4.8 out of 5,
                      37 reviews, hired 12 times" — and the first of them is
                      the only one whose subject is not stated. */}
                  <span className="slot-sr">Rated </span>
                  {s.rating.toFixed(1)}
                  <span className="slot-sr"> out of 5</span>
                  {s.review_count > 0 && (
                    <span className="slot-rate-n">
                      ({s.review_count}
                      <span className="slot-sr"> reviews</span>)
                    </span>
                  )}
                </span>
              )}

              {s.hired_count > 0 && (
                <span className="slot-fact">
                  Hired {s.hired_count}
                  {s.hired_count === 1 ? ' time' : ' times'}
                </span>
              )}

              {/* Records that a check was run. Not a licence, and not this site
                  vouching for what came back — so it says the noun and nothing
                  else. */}
              {s.background_check && (
                <span className="slot-chk">Background check</span>
              )}

              {s.years_in_business !== null && (
                <span className="slot-fact">
                  {s.years_in_business}
                  {s.years_in_business === 1 ? ' year' : ' years'} in business
                </span>
              )}
            </span>
          )}

          {/* One line, cut with an ellipsis. The author is a separate element
              so it is the review that gets cut and never the name of the person
              who wrote it — an anonymous quotation is worth less than no
              quotation. */}
          {s.review_snippet && (
            <span className="slot-quote">
              <span className="slot-quote-body">
                “{s.review_snippet.body}”
              </span>
              <span className="slot-quote-by">
                {s.review_snippet.author}
              </span>
            </span>
          )}
        </span>
      )}

      {/* WHERE, IN ONE PILL, AND THE BEST ANSWER WE HAVE.
          `proximity` is the strongest of the three because it is measured
          against this visitor's own address — how far off their route the
          van would come — and it is the reason to press this card rather
          than the one beside it. It only exists once a postcode has been
          given, and before that this pill said "They come to you", which is
          true of every card on the page and therefore tells nobody anything.
          The neighbourhood is the answer in between: not where the visitor
          is, but where this particular opening is, which is the question
          somebody scanning a city-wide grid is actually asking. The three
          are exclusive because the pill is one line on a 268px card, and a
          fallback still has to be there for a row we know neither for. */}
      <span className="slot-foot">
        {s.proximity
          ? <span className="slot-near">{s.proximity}</span>
          : area
            ? <span className="slot-near plain">In {area}</span>
            : <span className="slot-near plain">They come to you</span>}
        <span className="slot-go">Book</span>
      </span>
    </a>
  );
}
