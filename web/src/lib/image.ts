/**
 * Shrinks a photo in the browser before it is uploaded.
 *
 * A phone camera produces a 3-5 MB file. A profile gallery never displays it
 * larger than about 1200px wide, so uploading the original wastes the
 * customer's data allowance, the operator's time on a van's phone signal, and
 * storage that is charged by the gigabyte. Ten thousand operators with twelve
 * photos each is roughly 360 GB of originals against 24 GB re-encoded — the
 * same pictures, at a fifteenth of the cost.
 *
 * Done here rather than on the server because a Worker resizing images costs
 * CPU time on every upload, and the phone has already done the hard part.
 *
 * IT IS ALSO THE RE-ENCODE, and that is now the more important of its two
 * jobs. An iPhone photographs in HEIC unless somebody changed a setting, and
 * NO PHOTO ROUTE IN THIS PRODUCT ACCEPTS HEIC except the job-proof gallery —
 * conversation photos and portfolio photos are both WEB_IMAGE_TYPES, the three
 * formats every browser can actually draw. src/lib/chat.ts spells out why at
 * length: a conversation photograph exists to be looked at immediately by the
 * other person, and a format half the desktop browsers render as a torn-page
 * icon is a message that silently did not arrive. Running the picture through
 * a canvas is what turns the iPhone's HEIC into a JPEG or a WebP, and it is the
 * only reason an iPhone user gets anything other than `bad_type`.
 *
 * WHICH IS WHY THE OLD PASS-THROUGH BEHAVIOUR HAD TO GO. Both of the "we could
 * not re-encode this" branches below used to hand the caller back the ORIGINAL
 * file with a comment saying the server still checks type and size. That is
 * true and it is also the worst possible outcome: the one file the browser
 * could not decode is, overwhelmingly, the HEIC, so the branch that existed to
 * be forgiving was the branch that guaranteed the iPhone user uploaded several
 * megabytes over a driveway's worth of signal in order to be told `bad_type` at
 * the end of it. A refusal the person can read and act on, raised before
 * anything is sent, is the only honest version of that.
 */

const MAX_EDGE = 1600;
const QUALITY = 0.82;

/**
 * What the Worker will store, on every photo route this app posts to.
 *
 * Word for word WEB_IMAGE_TYPES in src/lib/images.ts, and pinned against it by
 * test/two-trees.test.ts — the two trees cannot import each other, so this list
 * is a deliberate second copy and the test is what stops it drifting. A copy
 * that grew a format the Worker refuses would offer people an upload that
 * always fails; one that lost a format the Worker takes would re-encode
 * pictures that never needed it.
 *
 * NOT THE `accept` ATTRIBUTE ON A FILE INPUT, and that distinction matters.
 * A picker restricted to these three is a picker an iPhone owner cannot choose
 * their own camera roll from. The input stays `image/*`, the HEIC comes in, and
 * this file turns it into something on this list.
 */
export const WEB_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const isWebType = (type: string): boolean =>
  (WEB_IMAGE_TYPES as readonly string[]).includes(type);

/**
 * Raised when this browser cannot turn what was picked into something the
 * Worker would take.
 *
 * Its own class rather than a bare Error so a caller can tell it apart from a
 * failed request and show it as what it is — a problem with the file, fixable
 * by choosing a different one — instead of as "something went wrong". The
 * message is written to be shown to a person as it stands.
 */
export class UnusableImage extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnusableImage';
  }
}

/** Browsers that cannot encode WebP fall back to JPEG, which all of them can. */
async function bestType(): Promise<'image/webp' | 'image/jpeg'> {
  if (typeof document === 'undefined') return 'image/jpeg';
  const probe = document.createElement('canvas');
  probe.width = 1; probe.height = 1;
  return probe.toDataURL('image/webp').startsWith('data:image/webp')
    ? 'image/webp' : 'image/jpeg';
}

export interface Shrunk {
  file: File;
  /**
   * The size of the file being handed back, in pixels — the re-encoded one when
   * there is one, the original when there is not. Never a size the caller has
   * to work out for itself, and never zero on this side of the wire: a caller
   * that got a Shrunk got a picture this browser decoded.
   */
  width: number;
  height: number;
}

export async function shrinkImage(
  file: File,
  opts: {
    /**
     * The caller's ceiling for the finished file, if it has one.
     *
     * Only the size-regression branch reads it, and it reads it for one
     * specific reason: that branch prefers the ORIGINAL file when re-encoding
     * made things bigger, and an original that is over the caller's limit is
     * not a preference, it is an upload that will be refused. Left out, the
     * branch behaves as it always did.
     */
    maxBytes?: number;
  } = {},
): Promise<Shrunk> {
  // Decoded first and the declared type asked about second, deliberately. Some
  // Android pickers hand over a photo with an empty `type`, and a file this
  // browser can draw is a file this browser can re-encode whatever its headers
  // claim. The type only decides what happens when the decode FAILS.
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return asIsOrRefuse(file);

  // Read before close(). A closed ImageBitmap reports 0 for both, which is how
  // a caller ends up being told a photograph has no dimensions.
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;

  const scale = Math.min(1, MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) { bitmap.close(); return asIsOrRefuse(file, sourceWidth, sourceHeight); }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const type = await bestType();
  const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, type, QUALITY));
  if (!blob) return asIsOrRefuse(file, sourceWidth, sourceHeight);

  // If re-encoding somehow made it bigger — a small PNG screenshot can do this
  // — keep the original. The point is fewer bytes, not more work.
  //
  // Two conditions on it that were not there before. The original has to be a
  // format the Worker accepts, or "keep the original" means keeping the HEIC
  // this whole function exists to get rid of; and it has to fit the caller's
  // ceiling, or it means preferring a file that is about to be refused for its
  // size over one that would have gone through.
  if (blob.size >= file.size
    && isWebType(file.type)
    && (opts.maxBytes === undefined || file.size <= opts.maxBytes)) {
    // The ORIGINAL's dimensions, not the scaled ones. This used to report the
    // size of a picture it was not handing back, which for a caller reserving
    // a box in a message thread is simply a wrong number.
    return { file, width: sourceWidth, height: sourceHeight };
  }

  const name = file.name.replace(/\.[^.]+$/, '') + (type === 'image/webp' ? '.webp' : '.jpg');
  return { file: new File([blob], name, { type }), width, height };
}

/**
 * What to do with a file this browser could not re-encode.
 *
 * A JPEG or PNG that the canvas refused is unusual but harmless — the bytes are
 * already a format the Worker stores, so sending them untouched costs the
 * person nothing but their data allowance. Anything else is a file the Worker
 * is certain to refuse, and saying so now is the whole point: see the note at
 * the top of this file about what the old unconditional pass-through cost an
 * iPhone user.
 *
 * The dimensions default to zero because the only way to be here without them
 * is a decode that never happened. Callers are entitled to that being honest
 * rather than being a guess.
 */
function asIsOrRefuse(file: File, width = 0, height = 0): Shrunk {
  if (isWebType(file.type)) return { file, width, height };
  throw new UnusableImage(
    'This device could not prepare that picture. Take a photo with the camera, '
    + 'or pick a JPEG or PNG instead.');
}
