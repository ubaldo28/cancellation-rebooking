import { badRequest } from './util';

/**
 * The photo store: one Workers KV namespace holding every image this product
 * keeps, and the two functions allowed to touch it.
 *
 * WHY KV, AND WHY THIS IS NOT R2 ANY MORE.
 *
 * This was written against R2, which is the right shape for the job: an object
 * store, no per-object ceiling worth thinking about, strongly consistent, a
 * `writeHttpMetadata` that hands you the content type back on the way out.
 * None of that ever ran. Enabling R2 on a Cloudflare account requires
 * attaching a subscription to a card on file, and this product is run on a
 * zero budget by one person, so the binding sat commented out in wrangler.toml
 * for the whole life of the codebase. `env.PHOTOS` was undefined in
 * production. Every photo route answered 503 and every photo delete in the
 * retention and erasure paths quietly did nothing, from the first deploy to
 * this one. The cost of the old state was not "R2 is unconfigured", it was
 * that a marketplace whose whole pitch is "look at the pictures of their
 * finished work before you let them into your driveway" shipped with no
 * pictures, and nobody could turn them on without a card.
 *
 * Workers KV needs no card and no subscription. It is a worse fit and it is
 * the store that actually exists, which beats the better fit that does not.
 *
 * WHAT IT COSTS, IN NUMBERS, BECAUSE THEY ARE SMALL AND THEY ARE THE POINT.
 * From Cloudflare's KV limits page, on the free plan:
 *
 *   - 1 GB of stored data FOR THE WHOLE ACCOUNT. Not a gigabyte a month, not a
 *     gigabyte per namespace -- a gigabyte, standing, shared with anything
 *     else this account ever puts in KV. When it is full it is full and the
 *     next put fails. At the 5 MB profile cap that is a low-hundreds number of
 *     photographs for the entire product, which is the single hardest limit
 *     here and the one most likely to be hit first. The retention sweep in
 *     retention.ts is therefore not housekeeping any more, it is the thing
 *     that keeps the store usable at all.
 *   - 25 MiB per value. MAX_PHOTO_VALUE_BYTES below, and putPhoto refuses
 *     anything over it rather than letting KV refuse it -- see the note there.
 *   - 1,000 writes a day, 100,000 reads a day.
 *
 * ON THE DAILY WRITE CEILING, AND WHY NOTHING NEW GUARDS IT.
 *
 * One upload is one write. The upload routes are already rate limited -- 60 an
 * hour per operator on the portfolio, 120 an hour per operator on job proof,
 * 40 an hour per guest link -- and those are per-principal, so they bound one
 * person and not the account total that KV actually meters. Taken literally
 * one operator could spend the whole account's daily writes in an afternoon.
 *
 * What stops that in practice is not the rate limit, it is the hard per-record
 * caps sitting behind it: a portfolio is MAX_PHOTOS (5) photographs and a
 * booking is MAX_PER_ITEM (24), both enforced on the row and not on the
 * request, so the realistic daily total is "how many jobs happened today"
 * rather than "how fast can somebody hold down the button".
 *
 * A global daily write counter was considered and deliberately not added. It
 * would convert one busy day into an outage for every operator at once --
 * nobody can upload proof of the job they are standing in front of -- in
 * exchange for avoiding a failure mode that already fails safely: hitting the
 * KV ceiling makes ONE put throw, the route turns that into an error the
 * uploader sees, and the row is never written because putPhoto runs first.
 * A shared limiter is the worse of the two failures. If the daily ceiling ever
 * starts actually being hit, the fix is fewer or smaller photographs (a
 * tighter cap, a shorter retention window), not a counter that rations them.
 *
 * CONSISTENCY IS WEAKER THAN IT WAS, AND ONE THING DEPENDS ON IT.
 *
 * R2 was strongly consistent: put returned, get saw it, everywhere. KV is not.
 * A read served from a different Cloudflare location than the write can still
 * answer "not found" for a short while after a put. The place that shows is
 * the profile page rendering <img src="/api/public/photo/..."> the instant the
 * upload response comes back, which can miss and show a broken image until a
 * reload. That is a visible wart and it is accepted on purpose: the row is
 * written, the photograph is stored, nothing is lost, and a reload fixes it.
 * Nothing in this product reads a photograph back as part of a decision --
 * there is no code path that treats "get returned null" as "the upload
 * failed", and there must not be one added, because under KV that inference
 * is simply wrong.
 *
 * THE COLUMN IS STILL CALLED `r2_key`, IN job_photos AND IN work_photos.
 *
 * Deliberately not renamed. The name is wrong -- there is no R2 bucket and
 * there never was one in production -- but it is a NOT NULL column in two
 * shipped migrations (0008_profiles.sql and 0025_proof.sql), read by name in
 * proof.ts, profile.ts, public.ts, retention.ts, seo.ts, the public API
 * payload and the React tree that renders it. Renaming it means a migration
 * that rewrites both tables plus a simultaneous change to every query and to
 * the JSON shape the web app already consumes, on a live deployment, to fix a
 * name. That trade is not worth taking on a marketplace that is taking real
 * payments. So the name outlived the service: read `r2_key` as "the key of
 * this photograph in the photo store", and the photo store is the KV namespace
 * described in this file.
 */

/** What an entry in the photo store looks like once it is read back. */
export interface StoredPhoto {
  /** The bytes, as a stream, ready to hand straight to a Response. */
  body: ReadableStream;
  /**
   * The content type recorded at upload, or null if the entry predates this
   * metadata or was written by something else. Callers decide the fallback:
   * the two routes that hold a database row use its `content_type` column,
   * which is the same sniffed value, and the one route that does not is
   * explicit about serving an unknown type as bytes rather than guessing.
   */
  contentType: string | null;
}

/**
 * What is carried alongside the bytes.
 *
 * R2 had `httpMetadata`, a first-class place for the content type that it
 * would write back onto a Response for you with `writeHttpMetadata`. KV has no
 * such thing. It has one opaque metadata blob per key, returned by
 * `getWithMetadata` and by nothing else -- a plain `get` throws it away
 * silently -- which is why every read in this file goes through
 * `getWithMetadata` even when the caller does not want the metadata.
 *
 * Only the content type lives in here, and it is the SNIFFED one from
 * images.ts, never the Content-Type the uploader typed. That distinction is
 * the entire reason cleanImageUpload exists: a file announced as image/jpeg
 * that is really HTML must be stored and served as what its bytes are, or the
 * first time it is served back a browser executes it.
 *
 * KV caps the metadata blob, which is another reason nothing else belongs in
 * here -- captions, dimensions and who uploaded it are columns on the row,
 * where they can be queried, and the row is the record of truth regardless.
 */
export interface PhotoMetadata {
  contentType?: string;
}

/**
 * The biggest value KV will accept: 25 MiB.
 *
 * Nothing should ever reach this. Both upload doors cap at 2 MB
 * (MAX_PHOTO_BYTES, profile.ts and MAX_BYTES, proof.ts), well under it, and
 * both check before the bytes are buffered. This is the backstop
 * for the day somebody raises one of those caps without knowing the store
 * underneath has a ceiling of its own: KV would refuse the put with an error
 * about request size, which reads like an outage rather than "that photo is
 * too big", and the caller would get a 500 instead of the same refusal the
 * door would have given them.
 */
export const MAX_PHOTO_VALUE_BYTES = 25 * 1024 * 1024;

/**
 * Stores one photograph.
 *
 * The content type given here must be the sniffed one. This deliberately
 * takes the namespace rather than the whole Env: `env.PHOTOS` is optional and
 * every caller has to have already decided what to do when it is missing, so
 * passing the binding in is what makes that decision visible at the call site
 * instead of buried one frame down.
 *
 * There is no cache-control in the metadata, and there was one in the R2
 * version. It was never used: every route that serves a photograph sets its
 * own cache-control header by hand, because the right answer differs -- a
 * public portfolio picture is immutable for a year and a picture of the inside
 * of somebody's house is private and short-lived. Carrying a value nobody
 * reads is how the two eventually disagree.
 */
export async function putPhoto(
  photos: KVNamespace, key: string, bytes: Uint8Array, contentType: string,
): Promise<void> {
  if (bytes.length > MAX_PHOTO_VALUE_BYTES) {
    throw badRequest('That photo is too big. Try again from the app.', 'too_big');
  }
  const metadata: PhotoMetadata = { contentType };
  await photos.put(key, bytes, { metadata });
}

/**
 * Reads one photograph back, or null if there is no such key.
 *
 * Null means the same thing it meant under R2 -- no such object -- and every
 * caller already treats it as a 404. KV returns null for a missing key exactly
 * as R2 returned null for a missing object, so the null handling above each
 * call site did not have to change and has been left alone.
 *
 * `'stream'` and not `'arrayBuffer'`: a photograph is up to several megabytes
 * and there is no reason to hold one in the isolate's memory in order to copy
 * it into a Response that is going to stream it anyway.
 */
export async function getPhoto(
  photos: KVNamespace, key: string,
): Promise<StoredPhoto | null> {
  const { value, metadata } = await photos.getWithMetadata<PhotoMetadata>(key, 'stream');
  if (!value) return null;
  return { body: value, contentType: metadata?.contentType ?? null };
}
