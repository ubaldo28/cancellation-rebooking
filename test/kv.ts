import type { PhotoMetadata } from '../src/lib/photostore';

/**
 * Enough of a Workers KV namespace to test the photo store against.
 *
 * ONE COPY, SHARED, ON PURPOSE. There used to be six near-identical fake R2
 * buckets, one per test file, each implementing whichever two methods that
 * file happened to call. That was survivable when the store's whole API was
 * `put`, `get` and `delete` with the content type carried in a field R2 filled
 * in for you. It is not survivable now: the content type is only reachable
 * through `getWithMetadata`, a plain `get` silently drops it, and a fake that
 * is generous about which of those returns metadata would let a bug where the
 * Worker reads the wrong one pass in every file at once. There is one fake and
 * it is exact.
 *
 * WHAT IT MODELS THAT MATTERS, AND WHY EACH ONE IS HERE:
 *
 *   - `get` NEVER returns metadata. Real KV has no way to hand it back from
 *     this method; it is dropped with no error and no warning. A fake that
 *     helpfully returned it would make `getPhoto` look correct if somebody
 *     rewrote it to use `get`, and the photographs would start being served
 *     with no content type in production.
 *   - `getWithMetadata` on a MISSING key resolves to an object with a null
 *     value, not to null. This is the single easiest thing to get wrong in the
 *     move off R2, where `get` returned null for a missing object and every
 *     call site was written as `if (!object) throw notFound()`. Ported
 *     carelessly that check becomes `if (!result)`, which is never true, and a
 *     missing photograph turns into a 200 with an empty body instead of a 404.
 *   - Metadata is round-tripped through JSON, because real KV stores it as
 *     JSON and hands back a parsed copy rather than the object that was
 *     passed in. Anything that only survives by reference identity is a bug
 *     here and would be a bug in production.
 *   - Bytes are copied in and copied out, so a test that mutates what it read
 *     cannot change what is "stored".
 */

/** One stored value, flattened: the content type is the only metadata used. */
export interface FakeEntry {
  bytes: Uint8Array;
  contentType?: string;
}

export interface FakeKV {
  /**
   * The backing store, exposed for assertions. Tests read `.size`, `.has(key)`
   * and the entry itself; `seed` is the way to put something in without going
   * through `put`.
   */
  entries: Map<string, FakeEntry>;
  /** Drop a value straight in, as a photograph uploaded some time ago. */
  seed(key: string, contentType?: string, bytes?: Uint8Array): void;
  put(key: string, value: unknown, options?: { metadata?: unknown }): Promise<void>;
  get(key: string, type?: string): Promise<unknown>;
  getWithMetadata(
    key: string, type?: string,
  ): Promise<{ value: unknown; metadata: unknown; cacheStatus: string | null }>;
  delete(key: string): Promise<void>;
}

const copy = (b: Uint8Array) => new Uint8Array(b);

/** The value, shaped as the requested type. Only the two types in use. */
function shape(entry: FakeEntry, type?: string): unknown {
  if (type === 'stream') return new Blob([copy(entry.bytes)]).stream();
  if (type === 'arrayBuffer') return copy(entry.bytes).buffer;
  // KV's default is 'text'. Nothing in this product asks for it, so producing
  // it from the bytes is fine and it is here only so the fake is not lying
  // about what a plain get does.
  return new TextDecoder().decode(entry.bytes);
}

export function fakeKV(): FakeKV {
  const entries = new Map<string, FakeEntry>();

  return {
    entries,

    seed(key, contentType, bytes) {
      entries.set(key, { bytes: bytes ? copy(bytes) : new Uint8Array(), contentType });
    },

    async put(key, value, options) {
      let bytes: Uint8Array;
      if (value instanceof Uint8Array) bytes = copy(value);
      else if (typeof value === 'string') bytes = new TextEncoder().encode(value);
      else bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());

      // Through JSON, exactly as KV does. An object that only survives by
      // reference does not survive a real put.
      const metadata = options?.metadata == null
        ? undefined
        : JSON.parse(JSON.stringify(options.metadata)) as PhotoMetadata;

      entries.set(key, { bytes, contentType: metadata?.contentType });
    },

    async get(key, type) {
      const hit = entries.get(key);
      // Null for a missing key, which is the one thing that reads the same on
      // KV as it did on R2. Note what is NOT here: no metadata, ever.
      if (!hit) return null;
      return shape(hit, type);
    },

    async getWithMetadata(key, type) {
      const hit = entries.get(key);
      // NOT null on a miss. See the note at the top of this file.
      if (!hit) return { value: null, metadata: null, cacheStatus: null };
      const metadata: PhotoMetadata | null =
        hit.contentType === undefined ? null : { contentType: hit.contentType };
      return { value: shape(hit, type), metadata, cacheStatus: null };
    },

    async delete(key) {
      // No error and no signal when the key was not there, same as KV and
      // same as R2 -- which is why every delete in the Worker is fire and
      // forget with a .catch(() => {}) on it.
      entries.delete(key);
    },
  };
}
