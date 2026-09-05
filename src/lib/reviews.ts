import type { Env } from '../types';
import { threadByToken } from './chat';
import { notify } from './feed';
import { redactContact } from './redact';
import { badRequest, conflict, newId, notFound, now } from './util';

/**
 * Reviews.
 *
 * On the reference marketplace this is most of a profile page: a score, a
 * count, a five-bar distribution, the words people search for most, and then
 * the reviews themselves with the exact options each customer booked. It is
 * the thing a person actually reads before letting a stranger into their
 * house, and this product had none of it.
 *
 * ONE RULE ABOVE ALL: only a real, completed booking can leave one, and one
 * booking leaves at most one. That is enforced by the unique index on
 * order_item_id rather than by care, because it is the only thing that makes
 * the number mean anything. A marketplace with invented reviews is worth less
 * than a marketplace with none: the second is merely young, and the first is
 * lying to the exact people who are trusting it most.
 */

/** Long enough to say what happened, short enough that nobody writes an essay. */
const MAX_BODY = 2000;
const MAX_REPLY = 1000;

export interface Review {
  id: string;
  operator_id: string;
  order_item_id: string;
  author_name: string;
  rating: number;
  body: string | null;
  details: string | null;
  reply: string | null;
  replied_at: number | null;
  created_at: number;
  /**
   * Job photo ids the CUSTOMER chose to make public on this review.
   *
   * Never every photo on the booking. Those are the inside of somebody's
   * house, taken as evidence for a dispute, and publishing them because they
   * happen to exist would be the worst kind of default. One at a time, opted
   * in, and only their own — see migration 0028.
   */
  photos?: string[];
}

export interface RatingSummary {
  /** Rounded to one decimal, the way a score is read. Null when there are none. */
  average: number | null;
  count: number;
  /** How many of each star, 5 down to 1, for the bars. */
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
  /**
   * "Exceptional", "Very good"… The reference labels the number, and the label
   * does more work than the digits: 4.9 and 5.0 are the same thing to a
   * reader, and a bare "4.9" invites arithmetic nobody wanted to do.
   */
  label: string | null;
}

const FIELDS =
  `id, operator_id, order_item_id, author_name, rating, body, details,
   reply, replied_at, created_at`;

/** The reference's own wording for a score. */
export function ratingLabel(average: number | null): string | null {
  if (average == null) return null;
  if (average >= 4.8) return 'Exceptional';
  if (average >= 4.5) return 'Very good';
  if (average >= 4.0) return 'Good';
  if (average >= 3.0) return 'Fair';
  return 'Poor';
}

/**
 * "Debra D." — the surname cut to an initial at display time.
 *
 * Cut here rather than stored short, so a correction stays possible and so the
 * rule can change without rewriting rows. A full surname next to a review of a
 * home visit is more identifying than anybody signing a review expects.
 */
export function displayName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'A customer';
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

export async function ratingFor(env: Env, operatorId: string): Promise<RatingSummary> {
  const rows = await env.DB.prepare(
    `SELECT rating, COUNT(*) AS n FROM reviews
      WHERE operator_id = ? AND hidden_at IS NULL
      GROUP BY rating`,
  ).bind(operatorId).all<{ rating: number; n: number }>();

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<1 | 2 | 3 | 4 | 5, number>;
  let sum = 0; let count = 0;
  for (const r of rows.results ?? []) {
    distribution[r.rating as 1 | 2 | 3 | 4 | 5] = r.n;
    sum += r.rating * r.n; count += r.n;
  }

  const average = count > 0 ? Math.round((sum / count) * 10) / 10 : null;
  return { average, count, distribution, label: ratingLabel(average) };
}

/**
 * Attaches the photos each review's customer released.
 *
 * One extra query for the whole page rather than one per review: a profile
 * with forty reviews would otherwise be forty round trips, and this is the
 * page every customer lands on.
 */
async function withPhotos(env: Env, reviews: Review[]): Promise<Review[]> {
  if (reviews.length === 0) return reviews;
  const ids = reviews.map((r) => r.order_item_id);
  const rows = await env.DB.prepare(
    `SELECT id, order_item_id FROM job_photos
      WHERE public_on_review = 1 AND order_item_id IN (${ids.map(() => '?').join(',')})
      ORDER BY created_at`,
  ).bind(...ids).all<{ id: string; order_item_id: string }>();

  const by = new Map<string, string[]>();
  for (const r of rows.results ?? []) {
    by.set(r.order_item_id, [...(by.get(r.order_item_id) ?? []), r.id]);
  }
  return reviews.map((r) => ({ ...r, photos: by.get(r.order_item_id) ?? [] }));
}

export async function listReviews(
  env: Env, operatorId: string, opts: { limit?: number; sort?: string } = {},
): Promise<Review[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 200);
  // A fixed set of orderings rather than an interpolated column name: this is
  // a public endpoint and the sort key comes from a query string.
  const order = opts.sort === 'highest' ? 'rating DESC, created_at DESC'
    : opts.sort === 'lowest' ? 'rating ASC, created_at DESC'
    : opts.sort === 'oldest' ? 'created_at ASC'
    : 'created_at DESC';

  const rows = await env.DB.prepare(
    `SELECT ${FIELDS} FROM reviews
      WHERE operator_id = ? AND hidden_at IS NULL
      ORDER BY ${order} LIMIT ?`,
  ).bind(operatorId, limit).all<Review>();
  return withPhotos(env, rows.results ?? []);
}

/**
 * The customer releases one of their own photos onto their review.
 *
 * Only their own: an operator has every commercial reason to publish their
 * best work and no way of knowing whether the customer minds their hallway
 * being on the internet. The person whose house it is decides, and there is
 * deliberately no operator path to this.
 */
export async function releasePhoto(
  env: Env, rawToken: string, photoId: string, isPublic: boolean,
): Promise<void> {
  const thread = await threadByToken(env, rawToken);
  if (!thread) throw notFound('That link is not valid any more.');

  const res = await env.DB.prepare(
    `UPDATE job_photos SET public_on_review = ?
      WHERE id = ? AND uploaded_by = 'customer' AND operator_id = ?
        AND order_item_id IN (
          SELECT id FROM order_items
           WHERE order_id = (SELECT order_id FROM order_items WHERE appointment_id = ? LIMIT 1))`,
  ).bind(isPublic ? 1 : 0, photoId, thread.operator_id, thread.appointment_id).run();

  if ((res.meta.changes ?? 0) === 0) throw notFound('That photo is not yours.');
}

/**
 * The words people mention most, as the reference shows them: "hair 103,
 * makeup 83, wedding 73".
 *
 * Counted over review bodies, stopwords dropped, and only words that show up
 * enough to be a pattern. It is a cheap feature that does something no summary
 * can: it tells a reader what this business is actually known for, in the
 * words of the people who paid for it.
 */
const STOPWORDS = new Set([
  'the', 'and', 'was', 'for', 'with', 'she', 'her', 'his', 'him', 'they', 'them',
  'that', 'this', 'have', 'had', 'has', 'are', 'were', 'you', 'your', 'our',
  'from', 'very', 'would', 'will', 'just', 'all', 'not', 'but', 'out', 'about',
  'what', 'when', 'been', 'their', 'there', 'which', 'more', 'than', 'also',
  'did', 'does', 'done', 'get', 'got', 'can', 'could', 'she', 'him', 'his',
  'into', 'over', 'after', 'before', 'again', 'really', 'made', 'make', 'time',
  'work', 'great', 'good', 'best', 'love', 'loved', 'nice', 'thank', 'thanks',
  'highly', 'recommend', 'recommended', 'definitely', 'absolutely', 'super',
  'amazing', 'awesome', 'excellent', 'perfect', 'wonderful', 'job', 'well',
]);

export async function mentionedWords(
  env: Env, operatorId: string, limit = 10,
): Promise<Array<{ word: string; n: number }>> {
  const rows = await env.DB.prepare(
    `SELECT body FROM reviews
      WHERE operator_id = ? AND hidden_at IS NULL AND body IS NOT NULL
      LIMIT 500`,
  ).bind(operatorId).all<{ body: string }>();

  const counts = new Map<string, number>();
  for (const r of rows.results ?? []) {
    // Counted once per review, not once per mention: one person writing
    // "hair" eleven times is one person who liked their hair.
    const seen = new Set<string>();
    for (const raw of r.body.toLowerCase().split(/[^a-z]+/)) {
      if (raw.length < 4 || STOPWORDS.has(raw) || seen.has(raw)) continue;
      seen.add(raw);
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, n]) => ({ word, n }));
}

// ---------------------------------------------------------------------------
// Leaving one
// ---------------------------------------------------------------------------

export interface LeaveInput {
  order_item_id: string;
  rating: number;
  body?: string | null;
}

/**
 * The customer leaves a review, authorised by their link.
 *
 * Only for a job that actually finished. A booking that was cancelled has
 * nothing to review -- whatever went wrong there is a cancellation, a refund
 * and possibly a fee, and letting it become a one-star review as well would
 * punish an operator twice for one event and hand any customer a lever.
 */
export async function leaveReview(
  env: Env, rawToken: string, input: LeaveInput,
): Promise<Review> {
  const rating = Math.round(Number(input?.rating));
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw badRequest('Pick between one and five stars.', 'bad_rating');
  }

  const thread = await threadByToken(env, rawToken);
  if (!thread) throw notFound('That link is not valid any more.');

  const item = await env.DB.prepare(
    `SELECT oi.id, oi.operator_id, oi.ends_at, oi.cancelled_at, o.guest_name,
            (SELECT GROUP_CONCAT(s.name, ' + ') FROM order_item_services s
              WHERE s.order_item_id = oi.id) AS services
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.id = ? AND oi.operator_id = ?
        AND oi.order_id = (SELECT order_id FROM order_items WHERE appointment_id = ? LIMIT 1)`,
  ).bind(input.order_item_id, thread.operator_id, thread.appointment_id).first<{
    id: string; operator_id: string; ends_at: number; cancelled_at: number | null;
    guest_name: string | null; services: string | null;
  }>();
  if (!item) throw notFound('That booking is not on your order.');
  if (item.cancelled_at) {
    throw conflict('That booking was cancelled, so there is nothing to review.',
      'was_cancelled');
  }
  if (item.ends_at > now()) {
    throw conflict('You can leave a review once the job is done.', 'too_early');
  }

  const t = now();
  const review: Review = {
    id: newId(),
    operator_id: item.operator_id,
    order_item_id: item.id,
    author_name: (item.guest_name ?? thread.guest_name ?? 'A customer').trim(),
    rating,
    // Filtered, because this one is PUBLISHED. A phone number in a chat
    // message reaches one person; the same number in a review sits on a public
    // profile page for anybody to find, and a customer signing their review
    // with their mobile out of habit has handed it to the whole internet.
    body: redactContact((input.body ?? '').trim().slice(0, MAX_BODY)).body.trim() || null,
    // Copied now, like the price on a receipt: the operator will rename that
    // service one day and this has to keep describing the job they had.
    details: item.services,
    reply: null,
    replied_at: null,
    created_at: t,
  };

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO reviews (id, operator_id, order_item_id, author_name, rating,
           body, details, reply, replied_at, hidden_at, hidden_reason,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,?)`,
      ).bind(review.id, review.operator_id, review.order_item_id, review.author_name,
        review.rating, review.body, review.details, t, t),
      // Kept on the operator because it is read on every card, pin and search
      // result, and an average recomputed over a growing table for each of
      // those is the query that gets slower for a year and then falls over.
      env.DB.prepare(
        `UPDATE operators SET rating_sum = rating_sum + ?, rating_count = rating_count + 1,
           updated_at = ? WHERE id = ?`,
      ).bind(rating, t, item.operator_id),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      throw conflict('You have already reviewed that booking.', 'already_reviewed');
    }
    throw e;
  }

  await notify(env, item.operator_id, {
    kind: 'chat_message',
    title: `${displayName(review.author_name)} left you ${rating} stars`,
    body: review.body?.slice(0, 140) ?? null,
    thread_id: thread.id,
  });

  return review;
}

/**
 * The business replies.
 *
 * Once. A reply that can be edited after the fact is a reply somebody can
 * quietly rewrite when the argument moves on, and on a public page the first
 * answer is the honest one.
 */
export async function replyToReview(
  env: Env, operatorId: string, reviewId: string, text: string,
): Promise<void> {
  // The operator's half, filtered for the same reason: a reply is public, and
  // "sorry about that, call me direct on ..." underneath a bad review is an
  // advert for taking the next job off the platform entirely.
  const reply = redactContact((text ?? '').trim().slice(0, MAX_REPLY)).body.trim();
  if (!reply) throw badRequest('Write something first.', 'empty_reply');

  const t = now();
  const res = await env.DB.prepare(
    `UPDATE reviews SET reply=?, replied_at=?, updated_at=?
      WHERE id=? AND operator_id=? AND reply IS NULL`,
  ).bind(reply, t, t, reviewId, operatorId).run();

  if ((res.meta.changes ?? 0) === 0) {
    throw conflict('That review is not yours, or you have already replied.',
      'cannot_reply');
  }
}

/** Which of this customer's finished jobs still have no review. */
export async function reviewableFor(env: Env, rawToken: string) {
  const thread = await threadByToken(env, rawToken);
  if (!thread?.appointment_id) return [];

  const rows = await env.DB.prepare(
    `SELECT oi.id AS order_item_id, oi.ends_at,
            (SELECT GROUP_CONCAT(s.name, ' + ') FROM order_item_services s
              WHERE s.order_item_id = oi.id) AS services
       FROM order_items oi
      WHERE oi.operator_id = ?
        AND oi.order_id = (SELECT order_id FROM order_items WHERE appointment_id = ? LIMIT 1)
        AND oi.cancelled_at IS NULL
        AND oi.ends_at <= ?
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.order_item_id = oi.id)`,
  ).bind(thread.operator_id, thread.appointment_id, now()).all();
  return rows.results ?? [];
}
