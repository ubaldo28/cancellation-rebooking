import type { Env } from '../types';
import { threadByToken } from './chat';
import { CAMERA_IMAGE_TYPES, cleanImageUpload } from './images';
import { flag } from './settlement';
import { badRequest, newId, notFound, now } from './util';

/**
 * Photographs of the job: before, during, after, from either side.
 *
 * Both sides upload because both sides have something to lose. The operator
 * needs a record against "they never turned up" on a job they did; the
 * customer needs one against "the work was done" on a job nobody came to. A
 * one-sided camera is not evidence, it is one person's account with pictures.
 *
 * And it does the bypass work almost incidentally: a job that happened leaves
 * photographs. Pictures uploaded after a cancellation are not a hint that the
 * work went ahead off the books, they are the thing itself.
 *
 * THESE ARE PRIVATE. They are the inside of somebody's house, their car, their
 * driveway, sometimes their children's things in the background. Visible to
 * the two people on that booking and to a dispute review, and to nobody else
 * ever: never on a public profile, never in search, never reused as marketing.
 * The operator's own portfolio is `work_photos` and is a different table for
 * precisely this reason -- one accidental join between the two would put a
 * customer's hallway on a business's advertising page.
 */

export type Stage = 'before' | 'during' | 'after';
export type Side = 'operator' | 'customer';

export const STAGES: readonly Stage[] = ['before', 'during', 'after'] as const;

/** Enough to show a job from a few angles; not a photo library. */
const MAX_PER_ITEM = 24;

/** Phone cameras produce large files; the client resizes before sending. */
export const MAX_BYTES = 6 * 1024 * 1024;

/**
 * HEIC is on this list and not on the public profile's, because this is a
 * camera roll rather than a web page: an iPhone photographing a job writes
 * HEIC unless somebody changed a setting, and refusing it would be refusing
 * the evidence. Nothing serves one of these to a browser anyway -- every read
 * goes through readJobPhoto, which authorises first.
 */
const ALLOWED = CAMERA_IMAGE_TYPES;

export interface JobPhoto {
  id: string;
  order_item_id: string;
  operator_id: string;
  uploaded_by: Side;
  stage: Stage;
  r2_key: string;
  content_type: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  caption: string | null;
  created_at: number;
}

const FIELDS =
  `id, order_item_id, operator_id, uploaded_by, stage, r2_key, content_type,
   bytes, width, height, caption, created_at`;

export const isStage = (v: unknown): v is Stage =>
  typeof v === 'string' && (STAGES as readonly string[]).includes(v);

/**
 * Resolves who is asking and whether this booking is theirs.
 *
 * The two sides authenticate completely differently -- the operator by
 * session, the customer by the secret in their link -- so this is the one
 * place that difference is handled, and every read and write below goes
 * through it. Two separate authorisation paths for one resource is how one of
 * them ends up being the loose one.
 */
async function scope(
  env: Env,
  who: { operator_id?: string; token?: string },
  orderItemId: string,
): Promise<{ side: Side; operator_id: string; cancelled_at: number | null }> {
  if (who.operator_id) {
    const row = await env.DB.prepare(
      `SELECT operator_id, cancelled_at FROM order_items WHERE id = ? AND operator_id = ?`,
    ).bind(orderItemId, who.operator_id).first<{
      operator_id: string; cancelled_at: number | null;
    }>();
    if (!row) throw notFound('That booking is not yours.');
    return { side: 'operator', operator_id: row.operator_id, cancelled_at: row.cancelled_at };
  }

  const thread = await threadByToken(env, who.token ?? '');
  if (!thread) throw notFound('That link is not valid any more.');
  const row = await env.DB.prepare(
    `SELECT operator_id, cancelled_at FROM order_items
      WHERE id = ? AND operator_id = ?
        AND order_id = (SELECT order_id FROM order_items WHERE appointment_id = ? LIMIT 1)`,
  ).bind(orderItemId, thread.operator_id, thread.appointment_id).first<{
    operator_id: string; cancelled_at: number | null;
  }>();
  if (!row) throw notFound('That booking is not on your order.');
  return { side: 'customer', operator_id: row.operator_id, cancelled_at: row.cancelled_at };
}

export interface UploadInput {
  order_item_id: string;
  stage: Stage;
  file: File;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
}

/**
 * Stores one photo against a booking.
 *
 * The object goes into R2 first and the row second, and the object is deleted
 * if the row is refused -- the row is the record of truth, and an orphaned
 * object is storage nobody can reach and everybody pays for.
 */
export async function addJobPhoto(
  env: Env, who: { operator_id?: string; token?: string }, input: UploadInput,
): Promise<JobPhoto> {
  if (!env.PHOTOS) {
    throw badRequest('Photo storage is not switched on yet.', 'no_storage');
  }
  if (!isStage(input.stage)) {
    throw badRequest('Say whether this is before, during or after.', 'bad_stage');
  }
  // Sized, identified by its own bytes, and stripped of where it was taken --
  // all before anything is stored. It used to be sized, and then trusted about
  // its type on the strength of a header the uploader typed, and then streamed
  // into the bucket exactly as it arrived, GPS and all. These are photographs
  // of the inside of somebody's house, and the customer can later publish one
  // of them on a public review; the coordinates cannot be allowed to be
  // sitting in the file when they do. See images.ts, which is honest about
  // what that guarantee is worth format by format.
  const { bytes, contentType } = await cleanImageUpload(input.file, {
    maxBytes: MAX_BYTES, allowed: ALLOWED,
  });

  const { side, operator_id, cancelled_at } = await scope(env, who, input.order_item_id);

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM job_photos WHERE order_item_id = ?`,
  ).bind(input.order_item_id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PER_ITEM) {
    throw badRequest('That booking already has plenty of photos.', 'too_many');
  }

  const key = `j/${operator_id}/${input.order_item_id}/${newId()}`;
  await env.PHOTOS.put(key, bytes, {
    httpMetadata: {
      // The sniffed type, not the declared one. What is stored and what is
      // served back have to be the same thing the bytes actually are.
      contentType,
      cacheControl: 'private, max-age=3600',
    },
  });

  const photo: JobPhoto = {
    id: newId(),
    order_item_id: input.order_item_id,
    operator_id,
    uploaded_by: side,
    stage: input.stage,
    r2_key: key,
    content_type: contentType,
    // What was stored, not what arrived. The stripped file is smaller than the
    // one the phone sent, and the row has to describe the object it points at.
    bytes: bytes.length,
    width: input.width ?? null,
    height: input.height ?? null,
    caption: (input.caption ?? '').trim().slice(0, 200) || null,
    created_at: now(),
  };

  try {
    await env.DB.prepare(
      `INSERT INTO job_photos (id, order_item_id, operator_id, uploaded_by, stage,
         r2_key, content_type, bytes, width, height, caption, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(photo.id, photo.order_item_id, photo.operator_id, photo.uploaded_by,
      photo.stage, photo.r2_key, photo.content_type, photo.bytes,
      photo.width, photo.height, photo.caption, photo.created_at).run();
  } catch (e) {
    await env.PHOTOS.delete(key).catch(() => {});
    throw e;
  }

  // A photograph of the job, taken after the job was cancelled. There are
  // innocent versions -- somebody uploading what they saw when they got there,
  // to show why they left -- so it is a flag for a person to read and never an
  // automatic charge. But it is the single most direct evidence that the work
  // went ahead off the books, and it costs nothing to notice.
  if (cancelled_at != null && photo.created_at > cancelled_at) {
    await flag(env, operator_id, input.order_item_id, 'photos_after',
      `A ${photo.stage} photo was added by the ${side} after the cancellation.`);
  }

  return photo;
}

/** Every photo on one booking, oldest first, once the caller is allowed them. */
export async function listJobPhotos(
  env: Env, who: { operator_id?: string; token?: string }, orderItemId: string,
): Promise<JobPhoto[]> {
  await scope(env, who, orderItemId);
  const rows = await env.DB.prepare(
    `SELECT ${FIELDS} FROM job_photos WHERE order_item_id = ? ORDER BY created_at`,
  ).bind(orderItemId).all<JobPhoto>();
  return rows.results ?? [];
}

/**
 * Streams one photo, to somebody who has proved they are on the booking.
 *
 * Deliberately NOT a public URL with an unguessable key. These are pictures of
 * people's homes: a key that leaks in a referrer header, a screenshot or a
 * support ticket would be a permanent public link to the inside of a
 * stranger's house. Every read is authorised, every time.
 */
export async function readJobPhoto(
  env: Env, who: { operator_id?: string; token?: string }, photoId: string,
): Promise<Response> {
  if (!env.PHOTOS) throw notFound('No such photo.');

  const photo = await env.DB.prepare(
    `SELECT ${FIELDS} FROM job_photos WHERE id = ?`,
  ).bind(photoId).first<JobPhoto>();
  if (!photo) throw notFound('No such photo.');

  await scope(env, who, photo.order_item_id);

  const object = await env.PHOTOS.get(photo.r2_key);
  if (!object) throw notFound('No such photo.');

  return new Response(object.body, {
    headers: {
      'content-type': photo.content_type ?? 'image/jpeg',
      // Private, and never shared: the URL is only meaningful to somebody who
      // already holds the session or the link that authorised it.
      'cache-control': 'private, max-age=3600',
    },
  });
}

/**
 * Removes a photo, but only the one who took it may.
 *
 * Neither side can delete the other's: a photograph that could be removed by
 * the person it is evidence against is not evidence. The row goes before the
 * object, so a failure leaves an object nobody references rather than a row
 * pointing at nothing.
 */
export async function deleteJobPhoto(
  env: Env, who: { operator_id?: string; token?: string }, photoId: string,
): Promise<void> {
  const photo = await env.DB.prepare(
    `SELECT ${FIELDS} FROM job_photos WHERE id = ?`,
  ).bind(photoId).first<JobPhoto>();
  if (!photo) throw notFound('No such photo.');

  const { side } = await scope(env, who, photo.order_item_id);
  if (side !== photo.uploaded_by) {
    throw notFound('No such photo.');
  }

  await env.DB.prepare(`DELETE FROM job_photos WHERE id = ?`).bind(photoId).run();
  if (env.PHOTOS) await env.PHOTOS.delete(photo.r2_key).catch(() => {});
}

/** What each side has put up, for the "before / during / after" strip. */
export async function proofSummary(
  env: Env, who: { operator_id?: string; token?: string }, orderItemId: string,
) {
  const photos = await listJobPhotos(env, who, orderItemId);
  const by = (stage: Stage) => photos.filter((p) => p.stage === stage);
  return {
    before: by('before'),
    during: by('during'),
    after: by('after'),
    total: photos.length,
  };
}
