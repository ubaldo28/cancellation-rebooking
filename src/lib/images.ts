import { badRequest } from './util';

/**
 * What is actually in an uploaded file, and getting the location out of it.
 *
 * Two separate jobs that belong in one place because they are the same
 * decision made twice: this product takes photographs of the inside of
 * customers' houses, their cars and their driveways, as evidence for disputes,
 * from a phone, with the camera app's defaults on. A modern phone photo
 * carries the coordinates of where it was taken, to a few metres, in a header
 * nobody looks at. Some of those photographs can later be published on a
 * public review by the customer who took them (migration 0028), and the file
 * that gets published is the file that was stored. So the coordinates have to
 * come off at the door, once, on the way in -- not at the point of publishing,
 * where a single missed path is somebody's home address on the internet.
 *
 * The type check is the other half of the same door. Neither the Content-Type
 * header nor the filename is evidence of anything: both are typed by the
 * caller, and "photo.jpg" declared image/jpeg can be an HTML file that a
 * browser will happily execute if it is ever served back with the wrong
 * headers. What the bytes begin with is the only thing here the uploader
 * cannot simply assert.
 */

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';

/** Everything a browser will render, which is what a public profile needs. */
export const WEB_IMAGE_TYPES: readonly ImageType[] =
  ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Everything a phone camera produces, which is what a job photo has to take. */
export const CAMERA_IMAGE_TYPES: readonly ImageType[] =
  ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;

const ascii = (d: Uint8Array, at: number, s: string): boolean => {
  if (at + s.length > d.length) return false;
  for (let i = 0; i < s.length; i++) if (d[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

const starts = (d: Uint8Array, bytes: number[]): boolean => {
  if (d.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (d[i] !== bytes[i]) return false;
  return true;
};

/**
 * The HEIF brands worth accepting.
 *
 * `heic`/`heix` are what an iPhone writes; `mif1`/`msf1` are the generic HEIF
 * brands it also puts in the compatible list. AVIF is deliberately absent: it
 * is the same container with a different codec, nothing here has asked for it,
 * and a format nobody sends is a format whose metadata nobody has thought
 * about.
 */
const HEIF_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1',
]);

/**
 * What the bytes say this is, or null.
 *
 * Null means "not one of the four", and the only correct response to it is to
 * refuse the upload. Storing something we could not identify and hoping is how
 * a bucket ends up serving whatever somebody felt like putting in it.
 */
export function sniffImageType(d: Uint8Array): ImageType | null {
  // SOI, then the first marker. Every JPEG in the wild starts FF D8 FF.
  if (starts(d, [0xFF, 0xD8, 0xFF])) return 'image/jpeg';

  if (starts(d, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';

  // RIFF <u32 size> WEBP
  if (ascii(d, 0, 'RIFF') && ascii(d, 8, 'WEBP')) return 'image/webp';

  // ISOBMFF: <u32 box size> 'ftyp' <major brand> <minor version> <compatible…>
  if (ascii(d, 4, 'ftyp')) {
    const size = Math.min(u32(d, 0), d.length);
    // The major brand, then every compatible brand after the minor version.
    // A phone writes major 'heic' but plenty of encoders write 'mif1' there
    // and put 'heic' in the compatible list, so both are read.
    for (let at = 8; at + 4 <= size; at += 4) {
      if (at === 12) continue;                       // minor_version, not a brand
      const brand = String.fromCharCode(d[at]!, d[at + 1]!, d[at + 2]!, d[at + 3]!);
      if (HEIF_BRANDS.has(brand)) return 'image/heic';
    }
  }

  return null;
}

const u16 = (d: Uint8Array, at: number) => (d[at]! << 8) | d[at + 1]!;
const u32 = (d: Uint8Array, at: number) =>
  ((d[at]! << 24) >>> 0) + (d[at + 1]! << 16) + (d[at + 2]! << 8) + d[at + 3]!;

/** RIFF is little-endian end to end, unlike everything else in this file. */
const u32le = (d: Uint8Array, at: number) =>
  d[at]! + (d[at + 1]! << 8) + (d[at + 2]! << 16) + (d[at + 3]! * 0x1000000);

// ---------------------------------------------------------------------------
// Stripping
// ---------------------------------------------------------------------------

/**
 * WHAT "STRIP" MEANS HERE, PER FORMAT, AND WHAT IT DOES NOT PROMISE.
 *
 * The honest summary first: for JPEG, PNG and WebP this rebuilds the file out
 * of the pixel-bearing parts and nothing else, so EXIF, GPS, XMP, IPTC, the
 * maker note, the embedded thumbnail and any comment are gone because they
 * were never copied across. For HEIC it does not rebuild anything -- it
 * overwrites the EXIF payload where the file's own index says it lives. That
 * is a weaker guarantee and it is written up in full below rather than
 * flattened into the same sentence as the others.
 *
 * JPEG. Rebuilt segment by segment, keeping everything except APP0-APP15
 * (FFE0-FFEF) and COM (FFFE), and stopping at EOI so that anything appended
 * after the image ends is dropped with it. EXIF, XMP, IPTC and the maker note
 * all live in APPn, so all of them go. What ALSO goes, and this is a real
 * cost rather than a bonus: the ICC colour profile is APP2 and the JFIF
 * density block is APP0, so a wide-gamut phone photo may render slightly
 * differently and a file that declared a print DPI loses it. That is accepted
 * on purpose. An allowlist of "safe" APPn markers is a list that has to be
 * kept correct forever by everybody who touches this file, and the failure
 * mode of getting it wrong once is a home address on a public page. What this
 * does NOT promise: a JPEG can carry text in the entropy-coded data itself,
 * and nothing here looks inside the image data. Nor is the image re-encoded,
 * so anything a camera embedded in the pixels -- a visible timestamp burned
 * into the corner -- is untouched, because it is a picture and not metadata.
 *
 * PNG. Rebuilt chunk by chunk, keeping only IHDR, PLTE, tRNS, IDAT and IEND.
 * eXIf (which is where a phone puts GPS in a PNG), tEXt, zTXt, iTXt and tIME
 * are dropped. Same accepted cost as JPEG: gAMA, cHRM, sRGB and iCCP go too,
 * so colour may shift slightly in a viewer that was relying on them. An
 * animated PNG comes out as its still first frame, because acTL/fcTL/fdAT are
 * not on the list. CRCs are recomputed for nothing -- every kept chunk is
 * copied whole, CRC included -- so a chunk that was corrupt arrives corrupt.
 *
 * WEBP. Rebuilt chunk by chunk, keeping the image chunks (VP8, VP8L, VP8X,
 * ALPH, ANIM, ANMF) and dropping EXIF, XMP and ICCP. The VP8X feature flags
 * are rewritten to clear the ICC, EXIF and XMP bits, because a decoder told
 * those sections exist and then not finding them is entitled to reject the
 * whole file. The RIFF length is rewritten to match.
 *
 * HEIC. Not rebuilt. An HEIF file is a box structure whose image data is
 * addressed by absolute file offsets held in the `iloc` table, so removing
 * bytes moves every offset in the file and rewriting them correctly by hand is
 * exactly the kind of code that works on the files it was tested against and
 * silently corrupts somebody's evidence photo two years later. Instead the
 * `meta` box is read to find which item is the EXIF, `iloc` is read to find
 * where that item's bytes are, and those bytes are overwritten with zeros in
 * place. Nothing moves, nothing is reindexed, the image itself is not touched,
 * and the file is exactly as long as it was.
 *
 * So for HEIC, specifically, this does NOT promise:
 *   - that the EXIF item is gone. It is still declared in `iinf` and still
 *     pointed at by `iloc`; its contents are zeros.
 *   - anything at all about items stored inside `idat` rather than at a file
 *     offset (construction_method 1). Those are skipped rather than guessed
 *     at, and no phone writes EXIF that way today.
 *   - anything about metadata carried in the HEVC bitstream itself, in SEI
 *     messages. Nothing here decodes the image.
 * XMP is handled where it appears as its own item with a recognised MIME type,
 * and that is the same in-place zeroing with the same caveats.
 *
 * NONE OF THE FOUR promises anything about what is visible in the photograph.
 * A picture of a front door with the number on it is a picture of a front
 * door with the number on it, and no header rewriting changes that.
 */
export function stripImageMetadata(type: ImageType, d: Uint8Array): Uint8Array {
  switch (type) {
    case 'image/jpeg': return stripJpeg(d);
    case 'image/png': return stripPng(d);
    case 'image/webp': return stripWebp(d);
    case 'image/heic': return stripHeic(d);
  }
}

/** Concatenates the ranges a stripper decided to keep. */
function join(d: Uint8Array, keep: Array<[number, number]>): Uint8Array {
  let n = 0;
  for (const [a, b] of keep) n += b - a;
  const out = new Uint8Array(n);
  let at = 0;
  for (const [a, b] of keep) { out.set(d.subarray(a, b), at); at += b - a; }
  return out;
}

function stripJpeg(d: Uint8Array): Uint8Array {
  const keep: Array<[number, number]> = [[0, 2]];   // SOI
  let i = 2;

  while (i + 1 < d.length) {
    if (d[i] !== 0xFF) break;                       // not at a marker: give up here
    let j = i;
    // Any number of FF fill bytes may precede a marker.
    while (j + 1 < d.length && d[j + 1] === 0xFF) j++;
    const marker = d[j + 1]!;

    // Standalone markers: no length, no payload.
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      keep.push([j, j + 2]); i = j + 2; continue;
    }
    if (marker === 0xD9) {                          // EOI
      keep.push([j, j + 2]);
      // Deliberately stops here. Whatever a camera or an editor appended after
      // the end of the image is not part of the image, and copying it forward
      // would carry across the one place a stripper is most often walked past.
      return join(d, keep);
    }

    if (j + 4 > d.length) break;
    const length = u16(d, j + 2);
    if (length < 2) break;                          // malformed; keep nothing further
    const end = j + 2 + length;
    if (end > d.length) break;

    const isApp = marker >= 0xE0 && marker <= 0xEF;
    const isComment = marker === 0xFE;
    if (!isApp && !isComment) keep.push([j, end]);
    i = end;

    if (marker === 0xDA) {
      // Start of scan: entropy-coded data with no length of its own, running
      // to the next real marker. FF00 is an escaped FF inside the data and
      // FFD0-FFD7 are restart markers, so neither ends it.
      let k = i;
      while (k + 1 < d.length) {
        if (d[k] === 0xFF) {
          const next = d[k + 1]!;
          if (next !== 0x00 && next !== 0xFF && !(next >= 0xD0 && next <= 0xD7)) break;
        }
        k++;
      }
      keep.push([i, k]);
      i = k;
    }
  }

  return join(d, keep);
}

/** The only PNG chunks that decide what the picture looks like. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

function stripPng(d: Uint8Array): Uint8Array {
  const keep: Array<[number, number]> = [[0, 8]];   // signature
  let i = 8;

  while (i + 8 <= d.length) {
    const length = u32(d, i);
    const end = i + 12 + length;                    // length + type + data + crc
    if (end > d.length || length > d.length) break;
    const type = String.fromCharCode(d[i + 4]!, d[i + 5]!, d[i + 6]!, d[i + 7]!);
    if (PNG_KEEP.has(type)) keep.push([i, end]);
    i = end;
    if (type === 'IEND') break;
  }

  return join(d, keep);
}

/** WebP chunks that carry image, alpha or animation. Everything else is metadata. */
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);

/**
 * VP8X feature flags for ICC, EXIF and XMP.
 *
 * A decoder that is told a section exists and then cannot find it is within
 * its rights to refuse the file, so dropping the chunks without clearing the
 * bits would turn a stripped photo into a broken one.
 */
const VP8X_ICC = 0x20, VP8X_EXIF = 0x08, VP8X_XMP = 0x04;

function stripWebp(d: Uint8Array): Uint8Array {
  const declared = u32le(d, 4) + 8;
  const limit = Math.min(Number.isFinite(declared) ? declared : d.length, d.length);

  const keep: Array<[number, number]> = [[0, 12]];  // RIFF, size, WEBP
  let i = 12;
  let vp8xFlagsAt = -1;

  while (i + 8 <= limit) {
    const fourcc = String.fromCharCode(d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!);
    const size = u32le(d, i + 4);
    // Chunks are padded to an even length, and the pad byte belongs to nobody.
    const end = i + 8 + size + (size % 2);
    if (end > d.length || size > d.length) break;
    if (WEBP_KEEP.has(fourcc)) {
      // Where the flags byte will land once everything before it is copied.
      if (fourcc === 'VP8X') {
        vp8xFlagsAt = keep.reduce((n, [a, b]) => n + (b - a), 0) + 8;
      }
      keep.push([i, end]);
    }
    i = end;
  }

  const out = join(d, keep);
  if (vp8xFlagsAt >= 0 && vp8xFlagsAt < out.length) {
    out[vp8xFlagsAt] = out[vp8xFlagsAt]! & ~(VP8X_ICC | VP8X_EXIF | VP8X_XMP);
  }
  // The RIFF length counts everything after the length field itself.
  const size = out.length - 8;
  out[4] = size & 0xFF; out[5] = (size >> 8) & 0xFF;
  out[6] = (size >> 16) & 0xFF; out[7] = (size >>> 24) & 0xFF;
  return out;
}

// ---------------------------------------------------------------------------
// HEIC
// ---------------------------------------------------------------------------

interface Box { type: string; start: number; body: number; end: number }

/** The boxes directly inside [from, to), shallow. */
function boxes(d: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let i = from;
  while (i + 8 <= to) {
    let size = u32(d, i);
    let body = i + 8;
    if (size === 1) {
      // 64-bit size. Anything whose high word is set is bigger than a photo
      // upload will ever be, and reading it as a JS number would lose
      // precision, so the walk stops rather than guessing.
      if (i + 16 > to || u32(d, i + 8) !== 0) break;
      size = u32(d, i + 12);
      body = i + 16;
    } else if (size === 0) {
      size = to - i;                                // runs to the end of the parent
    }
    const end = i + size;
    if (size < 8 || end > to) break;
    out.push({ type: String.fromCharCode(d[i + 4]!, d[i + 5]!, d[i + 6]!, d[i + 7]!),
      start: i, body, end });
    i = end;
  }
  return out;
}

/** Reads a big-endian integer of 0, 4 or 8 bytes, as iloc's size nibbles describe. */
function sized(d: Uint8Array, at: number, bytes: number): number {
  let n = 0;
  for (let i = 0; i < bytes; i++) n = n * 256 + d[at + i]!;
  return n;
}

/** item_ID -> what kind of item it is, from `iinf`. */
function heifItemTypes(d: Uint8Array, iinf: Box): Map<number, string> {
  const types = new Map<number, string>();
  const version = d[iinf.body]!;
  const at = iinf.body + 4 + (version === 0 ? 2 : 4);

  for (const infe of boxes(d, at, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const v = d[infe.body]!;
    let p = infe.body + 4;
    if (v >= 2) {
      const id = v === 2 ? u16(d, p) : u32(d, p);
      p += v === 2 ? 2 : 4;
      p += 2;                                       // protection index
      const itemType = String.fromCharCode(d[p]!, d[p + 1]!, d[p + 2]!, d[p + 3]!);
      types.set(id, itemType);
    }
    // Versions 0 and 1 have no item_type at all -- they predate the generic
    // item structure and only ever describe image items, never an EXIF blob.
    // There is nothing to find in one, so they are skipped rather than parsed.
  }
  return types;
}

/** item_ID -> the byte ranges of the item, from `iloc`, for file-offset items only. */
function heifItemExtents(d: Uint8Array, iloc: Box): Map<number, Array<[number, number]>> {
  const out = new Map<number, Array<[number, number]>>();
  const version = d[iloc.body]!;
  let p = iloc.body + 4;

  const offsetSize = d[p]! >> 4, lengthSize = d[p]! & 0xF;
  const baseOffsetSize = d[p + 1]! >> 4, indexSize = d[p + 1]! & 0xF;
  p += 2;

  const itemCount = version < 2 ? u16(d, p) : u32(d, p);
  p += version < 2 ? 2 : 4;

  for (let n = 0; n < itemCount && p < iloc.end; n++) {
    const id = version < 2 ? u16(d, p) : u32(d, p);
    p += version < 2 ? 2 : 4;

    let constructionMethod = 0;
    if (version === 1 || version === 2) { constructionMethod = u16(d, p) & 0xF; p += 2; }

    p += 2;                                         // data_reference_index
    const baseOffset = sized(d, p, baseOffsetSize); p += baseOffsetSize;
    const extentCount = u16(d, p); p += 2;

    const extents: Array<[number, number]> = [];
    for (let e = 0; e < extentCount; e++) {
      if ((version === 1 || version === 2) && indexSize > 0) p += indexSize;
      const offset = sized(d, p, offsetSize); p += offsetSize;
      const length = sized(d, p, lengthSize); p += lengthSize;
      // Only construction_method 0 -- a plain file offset. An item held in
      // `idat` is addressed relative to a box we would have to find and is
      // skipped rather than guessed at; see the note above stripImageMetadata.
      if (constructionMethod !== 0 || length === 0) continue;
      const a = baseOffset + offset;
      if (a >= 0 && a + length <= d.length) extents.push([a, a + length]);
    }
    if (extents.length) out.set(id, extents);
  }
  return out;
}

function stripHeic(d: Uint8Array): Uint8Array {
  const out = new Uint8Array(d);                    // never mutate the caller's bytes

  const meta = boxes(out, 0, out.length).find((b) => b.type === 'meta');
  if (!meta) return out;

  // `meta` is a FullBox: a version and flags before its children.
  const children = boxes(out, meta.body + 4, meta.end);
  const iinf = children.find((b) => b.type === 'iinf');
  const iloc = children.find((b) => b.type === 'iloc');
  if (!iinf || !iloc) return out;

  const types = heifItemTypes(out, iinf);
  const extents = heifItemExtents(out, iloc);

  for (const [id, type] of types) {
    // 'Exif' is the EXIF item. 'mime' is where XMP arrives when a phone writes
    // it; its content type is declared in the infe and is not read here,
    // because no `mime` item on a photograph is pixel data and there is
    // nothing lost by zeroing all of them.
    if (type !== 'Exif' && type !== 'mime') continue;
    for (const [a, b] of extents.get(id) ?? []) out.fill(0, a, b);
  }

  return out;
}

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

/**
 * Refuses a body that says up front it is too big.
 *
 * Content-Length is the caller's own claim and proves nothing, which is why
 * the real check below is on the bytes -- but a caller announcing forty
 * megabytes is telling the truth often enough that reading the whole multipart
 * body before saying no is work done for no reason. A caller who lies about it
 * downwards is caught one step later, having gained nothing.
 */
export function assertBodyWithin(req: Request, maxBytes: number): void {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw badRequest('That photo is too big. Try again from the app.', 'too_big');
  }
}

/**
 * The one gate an uploaded photo goes through before anything stores it.
 *
 * Order matters: size before reading, type from the bytes and never from the
 * headers, and only then the strip. What comes back is what should be written
 * to the bucket, and the content type that comes back is the sniffed one --
 * so a file uploaded as "image/jpeg" that is really a PNG is stored and served
 * as a PNG, rather than as a lie that some browser will eventually sniff its
 * own way out of.
 */
export async function cleanImageUpload(
  file: unknown, opts: { maxBytes: number; allowed: readonly ImageType[] },
): Promise<{ bytes: Uint8Array; contentType: ImageType }> {
  if (!(file instanceof File)) throw badRequest('No photo was sent.', 'no_file');

  // Before the buffer, not after. size is known from the multipart framing.
  if (file.size > opts.maxBytes) {
    throw badRequest('That photo is too big. Try again from the app.', 'too_big');
  }

  const raw = new Uint8Array(await file.arrayBuffer());
  if (raw.length === 0) throw badRequest('That photo is empty.', 'no_file');
  if (raw.length > opts.maxBytes) {
    throw badRequest('That photo is too big. Try again from the app.', 'too_big');
  }

  const type = sniffImageType(raw);
  if (!type || !opts.allowed.includes(type)) {
    // The same refusal whichever it was. A caller does not need to learn from
    // us which magic numbers get through.
    throw badRequest('That is not a photo we can store.', 'bad_type');
  }

  return { bytes: stripImageMetadata(type, raw), contentType: type };
}
