import type { Env } from '../types';
import { isDemoOperator } from './demo';
import { CARD_COLUMNS, cardFacts, type CardFacts, type CardRow } from './public';
import {
  displayName, listReviews, mentionedWords, ratingFor,
  type RatingSummary, type Review,
} from './reviews';
import { badRequest, conflict, newId, notFound, now } from './util';

/** A photograph of finished work, as the operator and the public both see it. */
export interface WorkPhoto {
  id: string;
  operator_id: string;
  r2_key: string;
  caption: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  content_type: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

/** What a stranger is allowed to see. Deliberately not `Operator`. */
export interface PublicProfileOperator {
  business_name: string;
  tagline: string | null;
  bio: string | null;
  years_experience: number | null;
  trade: string | null;
  avatar_key: string | null;
  country: string;

  /** The overview block, in the order the reference profile shows it. */
  work_location: 'i_travel' | 'they_travel' | 'both';
  employees: number;
  years_in_business: number | null;
  payment_methods: string | null;
  social_instagram: string | null;
  social_facebook: string | null;
  social_tiktok: string | null;

  /**
   * The whole of the credentials section on the reference: a background check
   * and a name. Not a licence gate.
   */
  background_check_name: string | null;
  background_checked_at: number | null;
  background_check_provider: string | null;

  /** "Hired 314 times". */
  hired_count: number;

  timezone: string;
  language: string;
  currency: string;
}

export interface ProfileFaq {
  id: string; question: string; answer: string; position: number;
}

/**
 * One thing this business does, priced.
 *
 * Four columns and no more. The services table also records what the operator
 * needs in order to do the job — whether parts have to be on hand, whether the
 * customer must be there, whether it can fill a gap at two hours' notice — and
 * those are their working notes, not a menu. A stranger reading the profile is
 * asking what is offered and what it costs.
 */
export interface PublicService {
  id: string;
  name: string;
  duration_seconds: number;
  price_cents: number;
}

/**
 * One band of the working week, in minutes from midnight in the operator's own
 * timezone — 540 is 09:00, as migration 0001 defines it. `timezone` comes back
 * on the operator, and without it these numbers cannot be read.
 *
 * A weekday can have several rows (a lunch break is two bands), and a weekday
 * with no rows is a day this business does not work. Nothing is filled in for
 * a missing day: an operator who has never set their hours has none, which is
 * a different statement from being closed all week, and the page has to be
 * able to tell those apart.
 */
export interface PublicHours {
  /** 0 = Sunday, matching the CHECK constraint on the column. */
  weekday: number;
  start_minute: number;
  end_minute: number;
}

export interface PublicProfile {
  operator: PublicProfileOperator;
  photos: WorkPhoto[];
  rating: RatingSummary;
  reviews: Review[];
  /** "hair 103, makeup 83" — what customers actually talk about. */
  mentions: Array<{ word: string; n: number }>;
  faqs: ProfileFaq[];
  /** "Serves Beverly Hills, CA". */
  areas: string[];
  /**
   * Everything this business sells, not only what happens to fit an open gap.
   *
   * The listing side of the site can only ever name the services attached to a
   * gap somebody has posted, which is a subset that changes hour to hour — so
   * a profile built from those alone shows a business as offering one thing on
   * Tuesday and four on Wednesday.
   */
  services: PublicService[];
  /** When they work. Empty when they have not said. */
  working_hours: PublicHours[];
  /**
   * A few other businesses doing the same work on the same patch.
   *
   * Carried on the profile payload rather than fetched separately because the
   * page needs it to render its own foot, and a second round trip for three
   * rows is a second round trip. Empty when this business is the only one in
   * its trade, or has no trade set — which the page has to render as the
   * absence it is rather than filling with anybody.
   */
  similar: SimilarBusiness[];
}

export interface PhotoInput {
  r2_key: string;
  content_type: string;
  bytes?: number | null;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
}

/** Twelve is a portfolio; more is a scroll nobody finishes. Also caps our bucket. */
export const MAX_PHOTOS = 12;

/** Anything else is either not an image or something a browser will refuse to render. */
export const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** 5 MB. A phone photo straight from the camera fits; a raw file does not. */
export const MAX_PHOTO_BYTES = 5_000_000;

const SLUG_MAX = 60;

/**
 * Business name to URL segment.
 *
 * Accents are folded rather than dropped, so "Café Móvil" becomes
 * "cafe-movil" and not "caf-vil" — a slug the owner would not recognise as
 * their own business is a slug they will not hand out.
 */
export function slugify(businessName: string): string {
  const folded = (businessName ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // strip the combining marks NFD exposed
    // Letters NFD does not decompose, so folding has to name them.
    .replace(/\u00df/g, 'ss')
    .replace(/\u00e6/g, 'ae')
    .replace(/\u0153/g, 'oe')
    .replace(/\u00f8/g, 'o')
    .replace(/\u0111/g, 'd')
    .toLowerCase();

  return folded
    .replace(/[^a-z0-9]+/g, '-')       // everything else becomes a separator
    .replace(/-+/g, '-')               // ...and repeats collapse to one
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');               // the slice can leave a trailing hyphen
}

/**
 * Gives an operator their public URL segment, once.
 *
 * Safe to call on every profile save: an operator who already has a slug keeps
 * it, because the link may already be printed on a van. On a collision the
 * next free `-2`, `-3`… is taken, and the unique index is the real arbiter —
 * two operators publishing the same business name in the same second cannot
 * both pass the SELECT, so the INSERT is retried rather than trusted.
 */
export async function ensureProfileSlug(
  env: Env, operatorId: string, businessName: string,
): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT profile_slug FROM operators WHERE id = ?`,
  ).bind(operatorId).first<{ profile_slug: string | null }>();

  if (!existing) throw notFound('No such operator.');
  if (existing.profile_slug) return existing.profile_slug;

  const base = slugify(businessName) || 'operator';

  // n === 1 is the bare slug; 2 upwards are the -2, -3… suffixes.
  for (let n = 1; n <= 200; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;

    const taken = await env.DB.prepare(
      `SELECT id FROM operators WHERE profile_slug = ? AND id <> ?`,
    ).bind(candidate, operatorId).first<{ id: string }>();
    if (taken) continue;

    try {
      const res = await env.DB.prepare(
        `UPDATE operators SET profile_slug = ?, updated_at = ?
          WHERE id = ? AND profile_slug IS NULL`,
      ).bind(candidate, now(), operatorId).run();

      // Lost the race to another request for this same operator — whatever it
      // set is now the slug, and it is as good as ours.
      if ((res.meta.changes ?? 0) === 0) {
        const again = await env.DB.prepare(
          `SELECT profile_slug FROM operators WHERE id = ?`,
        ).bind(operatorId).first<{ profile_slug: string | null }>();
        if (again?.profile_slug) return again.profile_slug;
        continue;
      }
      return candidate;
    } catch (e) {
      // The unique index rejected it: someone else took this slug between our
      // SELECT and our UPDATE. Try the next suffix.
      if (String(e).includes('UNIQUE') || String(e).includes('constraint')) continue;
      throw e;
    }
  }

  throw conflict('Could not find a free profile address for that name.', 'slug_exhausted');
}

/**
 * The public page.
 *
 * The column list here is the whole security boundary: email, phone, plan,
 * every tolerance and every setting are absent because they are not selected,
 * not because a caller remembered to strip them. Unpublished operators do not
 * exist as far as this function is concerned.
 */
export async function getPublicProfile(env: Env, slug: string): Promise<PublicProfile | null> {
  if (!slug) return null;

  const operator = await env.DB.prepare(
    `SELECT id, business_name, tagline, bio, years_experience, trade, avatar_key, country,
            work_location, employees, years_in_business, payment_methods,
            social_instagram, social_facebook, social_tiktok,
            background_check_name, background_checked_at, background_check_provider,
            hired_count, timezone, language, currency
       FROM operators
      WHERE profile_slug = ? AND is_published = 1`,
  ).bind(slug).first<PublicProfileOperator & { id: string }>();

  if (!operator) return null;

  const { id, ...safe } = operator;

  // Everything the reference profile leads with. The rating comes first
  // because it is the first thing a person reads, and the whole page is
  // arranged around the decision they are making: do I let this stranger into
  // my house.
  const [photos, rating, reviews, mentions, faqs, areas, services, hours, similar] =
    await Promise.all([
      listPhotos(env, id),
      ratingFor(env, id),
      listReviews(env, id, { limit: 20 }),
      mentionedWords(env, id),
      listFaqs(env, id),
      env.DB.prepare(
        `SELECT name FROM service_areas WHERE operator_id = ? AND is_active = 1
          ORDER BY name`,
      ).bind(id).all<{ name: string }>(),
      // Named columns rather than a star, for the same reason the operator
      // query above lists its own: what is not selected cannot leak, whatever
      // a later migration adds to the table.
      env.DB.prepare(
        `SELECT id, name, duration_seconds, price_cents FROM services
          WHERE operator_id = ? AND is_active = 1
          ORDER BY name`,
      ).bind(id).all<PublicService>(),
      // location_id is deliberately not read. It would tell a stranger how
      // many premises a business has and let two operators' hours be joined
      // through a shared address, and the profile only needs the week.
      env.DB.prepare(
        `SELECT weekday, start_minute, end_minute FROM working_hours
          WHERE operator_id = ?
          ORDER BY weekday, start_minute`,
      ).bind(id).all<PublicHours>(),
      // Keyed on the slug this function was called with rather than on `id`,
      // because "not me" is a statement about the page being rendered and the
      // slug is what identifies it.
      similarBusinesses(env, slug),
    ]);

  return {
    operator: safe,
    photos,
    rating,
    reviews: reviews.map((r) => ({ ...r, author_name: displayName(r.author_name) })),
    mentions,
    faqs,
    areas: (areas.results ?? []).map((a) => a.name),
    services: services.results ?? [],
    working_hours: hours.results ?? [],
    similar,
  };
}

// ---------------------------------------------------------------------------
// Other businesses doing the same work nearby
// ---------------------------------------------------------------------------

/**
 * An alternative business, as the foot of a profile page shows one.
 *
 * It carries exactly the facts a card carries — through cardFacts, so this
 * business cannot show four stars at the bottom of one page and nothing at the
 * top of its own — plus where it works and how much of that overlaps with the
 * business whose page this is. Nothing here is a recommendation: the ordering
 * is stated in `shared_areas` and `rating` and the reader can see both.
 */
export interface SimilarBusiness extends CardFacts {
  business_name: string;
  /** The `/p/:slug` segment. Never null: a row without one is not selected. */
  profile_slug: string;
  trade: string | null;
  tagline: string | null;
  /** Neighbourhoods this business works, by name. */
  areas: string[];
  /**
   * How many of those neighbourhoods the business whose page this is also
   * works. This is what "nearby" means here, and it is a count rather than a
   * distance because a mobile trade has no single address to measure from.
   */
  shared_areas: number;
  is_sample: boolean;
}

/** Three is what the reference shows under a profile, with a "see all" beside it. */
const DEFAULT_SIMILAR = 3;
const MAX_SIMILAR = 12;

/**
 * Other businesses in this trade whose patch overlaps this one's.
 *
 * The profile page dead-ends without this: a visitor who has decided against
 * the business they are looking at has nowhere to go but back to a search.
 *
 * "Nearby" is measured as shared service areas rather than as a distance,
 * because none of these businesses has a fixed address to measure from — they
 * are vans, and `service_areas` is the only statement any of them makes about
 * where they will actually go. Businesses sharing no area at all are still
 * returned, after the ones that do: a trade with three operators spread across
 * the Valley should show the other two rather than nothing, and the count is
 * on every row so the caller can say which is which.
 *
 * THE BUSINESS WHOSE PAGE IT IS IS EXCLUDED, in the WHERE clause rather than
 * filtered out afterwards, so it cannot reappear because a limit was applied
 * before the filter.
 */
export async function similarBusinesses(
  env: Env, slug: string, limit = DEFAULT_SIMILAR,
): Promise<SimilarBusiness[]> {
  const me = (slug ?? '').trim();
  if (!me) return [];

  const capped = Math.min(Math.max(1, Math.floor(limit)), MAX_SIMILAR);
  const t = now();

  const rows = await env.DB.prepare(
    `SELECT o.id, o.business_name, o.profile_slug, o.trade, o.tagline,
            ${CARD_COLUMNS},
            (SELECT COUNT(*) FROM service_areas a
              WHERE a.operator_id = o.id AND a.is_active = 1
                AND a.place_slug IS NOT NULL
                AND a.place_slug IN (SELECT m.place_slug FROM service_areas m
                                      WHERE m.operator_id = mine.id
                                        AND m.is_active = 1
                                        AND m.place_slug IS NOT NULL))
              AS shared_areas
       FROM operators o
       JOIN operators mine ON mine.profile_slug = ?
      WHERE o.id <> mine.id
        -- Same work. trade is free text on the row, compared the way every
        -- other reader of that column compares it.
        AND LOWER(TRIM(COALESCE(o.trade,''))) = LOWER(TRIM(COALESCE(mine.trade,'')))
        AND LOWER(TRIM(COALESCE(mine.trade,''))) <> ''
        -- Every one of these is a link, so it has to lead somewhere. The rest
        -- are the same conditions the listing applies before it will show a
        -- business to a stranger at all: a suspended business is not offered
        -- as an alternative to anybody.
        AND o.is_published = 1
        AND o.profile_slug IS NOT NULL
        AND o.accept_public_bookings = 1
        AND o.plan IN ('trial','active')
        AND o.banned_at IS NULL
        AND (o.suspended_until IS NULL OR o.suspended_until <= ?)
      -- Overlapping patch first, then the businesses a reader has most to go
      -- on. business_name breaks the tie so the list is stable between loads.
      ORDER BY shared_areas DESC, o.rating_count DESC, o.hired_count DESC,
               o.business_name
      LIMIT ?`,
  ).bind(me, t, capped).all<CardRow & {
    id: string; business_name: string; profile_slug: string;
    trade: string | null; tagline: string | null; shared_areas: number;
  }>();

  const found = rows.results ?? [];
  if (found.length === 0) return [];

  // One query for everybody's areas rather than one per business, for the same
  // reason withPhotos batches: three round trips to name three neighbourhoods
  // is three round trips too many on the page every customer lands on.
  const ids = found.map((r) => r.id);
  const areaRows = await env.DB.prepare(
    `SELECT operator_id, name FROM service_areas
      WHERE is_active = 1 AND operator_id IN (${ids.map(() => '?').join(',')})
      ORDER BY name`,
  ).bind(...ids).all<{ operator_id: string; name: string }>();

  const byOperator = new Map<string, string[]>();
  for (const a of areaRows.results ?? []) {
    byOperator.set(a.operator_id, [...(byOperator.get(a.operator_id) ?? []), a.name]);
  }

  return found.map((r) => ({
    business_name: r.business_name,
    profile_slug: r.profile_slug,
    trade: r.trade,
    tagline: r.tagline,
    areas: byOperator.get(r.id) ?? [],
    shared_areas: r.shared_areas ?? 0,
    is_sample: isDemoOperator(r.id),
    // The same facts the listing card shows, from the same function, with no
    // defaults: a business nobody has reviewed gets null rather than a number
    // this platform made up about somebody a reader is deciding whether to
    // let into their house. o.id is read for the sample check and the areas
    // above, and is not returned — it is an internal key.
    ...cardFacts(r, t),
  }));
}

/** The questions this business chose to answer, in the order they chose. */
export async function listFaqs(env: Env, operatorId: string) {
  const rows = await env.DB.prepare(
    `SELECT id, question, answer, position FROM operator_faqs
      WHERE operator_id = ? ORDER BY position, created_at`,
  ).bind(operatorId).all<{
    id: string; question: string; answer: string; position: number;
  }>();
  return rows.results ?? [];
}

export async function saveFaq(
  env: Env, operatorId: string,
  input: { id?: string | null; question: string; answer: string; position?: number },
) {
  const question = (input.question ?? '').trim().slice(0, 200);
  const answer = (input.answer ?? '').trim().slice(0, 2000);
  if (!question || !answer) {
    throw badRequest('A question needs both a question and an answer.', 'incomplete');
  }
  const t = now();
  if (input.id) {
    const res = await env.DB.prepare(
      `UPDATE operator_faqs SET question=?, answer=?, position=?, updated_at=?
        WHERE id=? AND operator_id=?`,
    ).bind(question, answer, input.position ?? 0, t, input.id, operatorId).run();
    if ((res.meta.changes ?? 0) === 0) throw notFound('No such question.');
    return { id: input.id };
  }
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO operator_faqs (id, operator_id, question, answer, position,
       created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
  ).bind(id, operatorId, question, answer, input.position ?? 0, t, t).run();
  return { id };
}

export async function deleteFaq(env: Env, operatorId: string, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM operator_faqs WHERE id=? AND operator_id=?`)
    .bind(id, operatorId).run();
}

/** An operator's photos in their chosen order. Scoped by operator_id, always. */
export async function listPhotos(env: Env, operatorId: string): Promise<WorkPhoto[]> {
  const rows = await env.DB.prepare(
    `SELECT id, operator_id, r2_key, caption, width, height, bytes, content_type,
            sort_order, created_at, updated_at
       FROM work_photos
      WHERE operator_id = ?
      ORDER BY sort_order, created_at`,
  ).bind(operatorId).all<WorkPhoto>();
  return rows.results ?? [];
}

/**
 * Records an uploaded photo.
 *
 * The type and size gates are repeated here rather than left to the upload
 * endpoint, because a row that outlives its object — or points at a 40 MB
 * file — is a broken public page nobody notices until a customer does.
 */
export async function addPhoto(
  env: Env, operatorId: string, input: PhotoInput,
): Promise<WorkPhoto> {
  const key = input.r2_key?.trim();
  if (!key) throw badRequest('That upload is missing its file.', 'bad_photo');

  if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(input.content_type)) {
    throw badRequest('Photos have to be a JPEG, PNG or WebP image.', 'bad_content_type');
  }
  if (input.bytes != null && (input.bytes <= 0 || input.bytes > MAX_PHOTO_BYTES)) {
    throw badRequest('That photo is larger than 5 MB.', 'photo_too_large');
  }

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM work_photos WHERE operator_id = ?`,
  ).bind(operatorId).first<{ n: number }>();

  if ((count?.n ?? 0) >= MAX_PHOTOS) {
    throw conflict(
      `You can show ${MAX_PHOTOS} photos. Remove one to add another.`, 'photo_limit');
  }

  const next = await env.DB.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM work_photos WHERE operator_id = ?`,
  ).bind(operatorId).first<{ n: number }>();

  const t = now();
  const photo: WorkPhoto = {
    id: newId(),
    operator_id: operatorId,
    r2_key: key,
    caption: input.caption?.trim() || null,
    width: input.width ?? null,
    height: input.height ?? null,
    bytes: input.bytes ?? null,
    content_type: input.content_type,
    sort_order: next?.n ?? 0,
    created_at: t,
    updated_at: t,
  };

  await env.DB.prepare(
    `INSERT INTO work_photos (id, operator_id, r2_key, caption, width, height, bytes,
       content_type, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(photo.id, photo.operator_id, photo.r2_key, photo.caption, photo.width,
    photo.height, photo.bytes, photo.content_type, photo.sort_order,
    photo.created_at, photo.updated_at).run();

  return photo;
}

/**
 * Removes one photo.
 *
 * operator_id is in the WHERE clause, not checked beforehand: an id guessed or
 * copied from another operator's page deletes nothing at all, and reports the
 * same "not found" a made-up id would, so the caller learns nothing either.
 * Returns the R2 key so the caller can delete the object it was pointing at.
 */
export async function deletePhoto(
  env: Env, operatorId: string, photoId: string,
): Promise<{ r2_key: string }> {
  const row = await env.DB.prepare(
    `SELECT r2_key FROM work_photos WHERE id = ? AND operator_id = ?`,
  ).bind(photoId, operatorId).first<{ r2_key: string }>();

  if (!row) throw notFound('That photo is not on your profile.');

  const res = await env.DB.prepare(
    `DELETE FROM work_photos WHERE id = ? AND operator_id = ?`,
  ).bind(photoId, operatorId).run();

  if ((res.meta.changes ?? 0) === 0) throw notFound('That photo is not on your profile.');
  return { r2_key: row.r2_key };
}

/**
 * Applies the operator's drag-and-drop order.
 *
 * Ids that are not theirs are ignored rather than rejected, and every UPDATE
 * carries operator_id, so a reorder cannot be used to shuffle — or even
 * confirm the existence of — another operator's photos. Anything they own but
 * left out keeps its place after the ones they named.
 */
export async function reorderPhotos(
  env: Env, operatorId: string, ids: string[],
): Promise<WorkPhoto[]> {
  const mine = await listPhotos(env, operatorId);
  const owned = new Set(mine.map((p) => p.id));

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of ids ?? []) {
    if (!owned.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  for (const p of mine) if (!seen.has(p.id)) ordered.push(p.id);

  if (ordered.length === 0) return mine;

  const t = now();
  await env.DB.batch(ordered.map((id, i) =>
    env.DB.prepare(
      `UPDATE work_photos SET sort_order = ?, updated_at = ?
        WHERE id = ? AND operator_id = ?`,
    ).bind(i, t, id, operatorId)));

  return listPhotos(env, operatorId);
}
