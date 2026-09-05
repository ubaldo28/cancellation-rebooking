import type { Env } from '../types';
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
  const [photos, rating, reviews, mentions, faqs, areas, services, hours] =
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
  };
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
