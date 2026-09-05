import { describe, expect, it } from 'vitest';
import {
  CAMERA_IMAGE_TYPES, WEB_IMAGE_TYPES, cleanImageUpload, sniffImageType, stripImageMetadata,
} from '../src/lib/images';

const { deflateSync } = (process as any).getBuiltinModule('node:zlib') as {
  deflateSync: (b: Uint8Array) => Buffer;
};

/**
 * The metadata stripper, against bytes built here rather than against a mock.
 *
 * Every file in this test is assembled from the format specification: real
 * segment markers, real chunk CRCs, a real TIFF header with a real GPS IFD in
 * it. That is the point. A stripper tested against a stand-in is a stripper
 * that passes on the day somebody's actual holiday photo of a boiler goes
 * through it with the coordinates still attached, and the thing being
 * protected here is where a customer lives.
 */

const bytes = (...xs: Array<number | number[] | Uint8Array | string>): Uint8Array => {
  const parts: number[] = [];
  for (const x of xs) {
    if (typeof x === 'number') parts.push(x);
    else if (typeof x === 'string') for (const c of x) parts.push(c.charCodeAt(0));
    else for (const b of x) parts.push(b);
  }
  return new Uint8Array(parts);
};

const be16 = (n: number) => [(n >> 8) & 0xFF, n & 0xFF];
const be32 = (n: number) => [(n >>> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF];
const le32 = (n: number) => [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF];

const text = (d: Uint8Array) => String.fromCharCode(...d);
const has = (d: Uint8Array, needle: Uint8Array | string) => {
  const n = typeof needle === 'string' ? bytes(needle) : needle;
  outer: for (let i = 0; i + n.length <= d.length; i++) {
    for (let j = 0; j < n.length; j++) if (d[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// A real EXIF block, with a real GPS IFD in it
// ---------------------------------------------------------------------------

/**
 * 34.1510 N, 118.4450 W as a camera would actually write it: a TIFF header,
 * an IFD0 pointing at a GPS IFD, and the latitude and longitude as
 * degrees/minutes/seconds rationals in the data area after it.
 *
 * These are the numbers the whole exercise is about. They are somebody's
 * street, to within a few metres, in a file that a customer can later publish
 * on a public review, and they arrive in every photograph a phone takes unless
 * something removes them.
 */
function exifWithGps(): Uint8Array {
  const rational = (num: number, den: number) => [...be32(num), ...be32(den)];
  // The DMS triples live after the two IFDs; offsets are from the TIFF header.
  const latAt = 8 + 18 + 6 + 62;
  const lngAt = latAt + 24;

  const ifd0 = bytes(
    ...be16(1),                                     // one entry
    ...be16(0x8825), ...be16(4), ...be32(1), ...be32(26),  // GPSInfoIFDPointer
    ...be32(0),                                     // no next IFD
  );

  const gpsIfd = bytes(
    ...be16(4),
    ...be16(0x0001), ...be16(2), ...be32(2), ...bytes('N'), 0, 0, 0,   // GPSLatitudeRef
    ...be16(0x0002), ...be16(5), ...be32(3), ...be32(latAt),           // GPSLatitude
    ...be16(0x0003), ...be16(2), ...be32(2), ...bytes('W'), 0, 0, 0,   // GPSLongitudeRef
    ...be16(0x0004), ...be16(5), ...be32(3), ...be32(lngAt),           // GPSLongitude
    ...be32(0),
  );

  const coords = bytes(
    ...rational(34, 1), ...rational(9, 1), ...rational(3600, 100),     // 34° 9' 36"
    ...rational(118, 1), ...rational(26, 1), ...rational(4200, 100),   // 118° 26' 42"
  );

  return bytes('MM', 0x00, 0x2A, ...be32(8), ifd0, gpsIfd, coords);
}

/** The bytes that ARE the coordinates, so their absence can be asserted directly. */
const GPS_DEGREES = bytes(...be32(34), ...be32(1), ...be32(9), ...be32(1));

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

const segment = (marker: number, payload: Uint8Array) =>
  bytes(0xFF, marker, ...be16(payload.length + 2), payload);

/** A structurally complete JPEG: every marker in the order a camera writes them. */
function jpegWithEverything() {
  const exif = exifWithGps();
  const app1 = segment(0xE1, bytes('Exif', 0, 0, exif));
  const app0 = segment(0xE0, bytes('JFIF', 0, 1, 2, 1, ...be16(72), ...be16(72), 0, 0));
  const app2 = segment(0xE2, bytes('ICC_PROFILE', 0, 1, 1, 0xDE, 0xAD));
  const app13 = segment(0xED, bytes('Photoshop 3.0', 0, '8BIM', 0x04, 0x04));
  const comment = segment(0xFE, bytes('Taken at home'));

  const dqt = segment(0xDB, bytes(0, ...new Array(64).fill(16)));
  const sof0 = segment(0xC0, bytes(8, ...be16(1), ...be16(1), 1, 1, 0x11, 0));
  const dht = segment(0xC4, bytes(0x00, ...new Array(16).fill(0), 0));
  const sos = segment(0xDA, bytes(1, 1, 0x00, 0, 63, 0));

  // Entropy-coded data with both of the things that are not markers in it: an
  // escaped FF (FF 00) and a restart marker (FF D0). A stripper that treats
  // either as the end of the scan truncates the picture.
  const scan = bytes(0x9A, 0xFF, 0x00, 0x3C, 0xFF, 0xD0, 0x7E, 0x11);

  // The image proper, from the first thing that is not metadata to EOI. It has
  // to come through byte for byte.
  const imageTail = bytes(dqt, sof0, dht, sos, scan, 0xFF, 0xD9);

  return {
    file: bytes(0xFF, 0xD8, app0, app1, app2, app13, comment, imageTail,
      // Some cameras and most "AI upscalers" append their own block after the
      // end of the image. It is not part of the picture and it is exactly
      // where a stripper that copies to EOF carries metadata across.
      'TRAILINGJUNK', exif),
    imageTail,
  };
}

describe('JPEG', () => {
  it('is recognised by its bytes and not by anybody saying so', () => {
    expect(sniffImageType(jpegWithEverything().file)).toBe('image/jpeg');
  });

  it('loses every APPn and the comment, and keeps the picture exactly', () => {
    const { file, imageTail } = jpegWithEverything();
    const out = stripImageMetadata('image/jpeg', file);

    expect([out[0], out[1]]).toEqual([0xFF, 0xD8]);
    // SOI, then the image, and nothing between or after them.
    expect(out).toEqual(bytes(0xFF, 0xD8, imageTail));

    // Said again as the thing that actually matters, so the assertion above
    // cannot pass for a subtle reason while this is still in the file.
    expect(has(out, 'Exif')).toBe(false);
    expect(has(out, GPS_DEGREES)).toBe(false);
    expect(has(out, 'Photoshop 3.0')).toBe(false);
    expect(has(out, 'ICC_PROFILE')).toBe(false);
    expect(has(out, 'Taken at home')).toBe(false);
    expect(has(out, 'JFIF')).toBe(false);
    expect(has(out, 'TRAILINGJUNK')).toBe(false);

    // And the parts that draw the picture are all still there.
    expect(has(out, bytes(0xFF, 0xDB))).toBe(true);
    expect(has(out, bytes(0xFF, 0xC0))).toBe(true);
    expect(has(out, bytes(0xFF, 0xDA))).toBe(true);
    expect([out[out.length - 2], out[out.length - 1]]).toEqual([0xFF, 0xD9]);
  });

  it('does not mistake an escaped FF or a restart marker for the end of the scan', () => {
    const { file } = jpegWithEverything();
    const out = stripImageMetadata('image/jpeg', file);
    // The scan bytes, whole. Truncating here is the classic way to hand back a
    // half-grey photograph that still opens.
    expect(has(out, bytes(0x9A, 0xFF, 0x00, 0x3C, 0xFF, 0xD0, 0x7E, 0x11))).toBe(true);
  });

  it('leaves a JPEG that never had any metadata byte for byte identical', () => {
    const clean = bytes(0xFF, 0xD8,
      segment(0xDB, bytes(0, ...new Array(64).fill(16))),
      segment(0xDA, bytes(1, 1, 0x00, 0, 63, 0)),
      0x12, 0x34, 0xFF, 0xD9);
    expect(stripImageMetadata('image/jpeg', clean)).toEqual(clean);
  });
});

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(d: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (const b of d) c = CRC_TABLE[(c ^ b) & 0xFF]! ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const chunk = (type: string, data: Uint8Array) => {
  const typed = bytes(type, data);
  return bytes(...be32(data.length), typed, ...be32(crc32(typed)));
};

/** A genuinely valid one-pixel PNG, with the metadata a phone would add. */
function pngWithEverything() {
  const ihdr = chunk('IHDR', bytes(...be32(1), ...be32(1), 8, 2, 0, 0, 0));
  // One red pixel: filter byte 0, then RGB.
  const idat = chunk('IDAT', new Uint8Array(deflateSync(bytes(0, 0xFF, 0x00, 0x00))));
  const iend = chunk('IEND', new Uint8Array(0));
  return {
    file: bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
      ihdr,
      chunk('eXIf', exifWithGps()),
      chunk('tEXt', bytes('Comment', 0, 'Taken at home')),
      chunk('iTXt', bytes('XML:com.adobe.xmp', 0, 0, 0, 0, 0, '<x:xmpmeta/>')),
      chunk('tIME', bytes(...be16(2026), 9, 5, 12, 0, 0)),
      idat, iend),
    ihdr, idat, iend,
  };
}

/** Walks the output as a decoder would, checking every CRC it finds. */
function pngChunks(d: Uint8Array) {
  const out: Array<{ type: string; ok: boolean }> = [];
  let i = 8;
  while (i + 12 <= d.length) {
    const len = (d[i]! << 24 >>> 0) + (d[i + 1]! << 16) + (d[i + 2]! << 8) + d[i + 3]!;
    const type = text(d.subarray(i + 4, i + 8));
    const stated = (d[i + 8 + len]! << 24 >>> 0) + (d[i + 9 + len]! << 16)
      + (d[i + 10 + len]! << 8) + d[i + 11 + len]!;
    out.push({ type, ok: crc32(d.subarray(i + 4, i + 8 + len)) === stated });
    i += 12 + len;
  }
  return out;
}

describe('PNG', () => {
  it('is recognised by its signature', () => {
    expect(sniffImageType(pngWithEverything().file)).toBe('image/png');
  });

  it('keeps only the chunks that draw the picture, and leaves them valid', () => {
    const { file, ihdr, idat, iend } = pngWithEverything();
    const out = stripImageMetadata('image/png', file);

    expect(out).toEqual(bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
      ihdr, idat, iend));

    // eXIf is where a phone puts GPS in a PNG, and it is the one that matters.
    expect(pngChunks(out).map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(pngChunks(out).every((c) => c.ok)).toBe(true);
    expect(has(out, GPS_DEGREES)).toBe(false);
    expect(has(out, 'Taken at home')).toBe(false);
    expect(has(out, 'xmpmeta')).toBe(false);
  });

  it('keeps a palette and its transparency, which decide what the picture looks like', () => {
    const ihdr = chunk('IHDR', bytes(...be32(1), ...be32(1), 8, 3, 0, 0, 0));
    const plte = chunk('PLTE', bytes(0xFF, 0x00, 0x00));
    const trns = chunk('tRNS', bytes(0x80));
    const idat = chunk('IDAT', new Uint8Array(deflateSync(bytes(0, 0))));
    const iend = chunk('IEND', new Uint8Array(0));
    const file = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
      ihdr, plte, chunk('tEXt', bytes('k', 0, 'v')), trns, idat, iend);

    const out = stripImageMetadata('image/png', file);
    expect(pngChunks(out).map((c) => c.type)).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
  });
});

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

const riffChunk = (fourcc: string, data: Uint8Array) =>
  bytes(fourcc, ...le32(data.length), data, ...(data.length % 2 ? [0] : []));

/** An extended WebP announcing alpha, an ICC profile, EXIF and XMP. */
function webpWithEverything() {
  const ICC = 0x20, ALPHA = 0x10, EXIF = 0x08, XMP = 0x04;
  const vp8x = riffChunk('VP8X', bytes(ICC | ALPHA | EXIF | XMP, 0, 0, 0,
    0, 0, 0, 0, 0, 0));
  const alph = riffChunk('ALPH', bytes(0x01, 0x02, 0x03));
  const vp8 = riffChunk('VP8 ', bytes(0xAA, 0xBB, 0xCC, 0xDD, 0xEE));
  const body = bytes('WEBP', vp8x,
    riffChunk('ICCP', bytes(0xDE, 0xAD, 0xBE, 0xEF)),
    alph, vp8,
    riffChunk('EXIF', exifWithGps()),
    riffChunk('XMP ', bytes('<x:xmpmeta>home</x:xmpmeta>')));
  return { file: bytes('RIFF', ...le32(body.length), body), vp8x, alph, vp8 };
}

describe('WebP', () => {
  it('is recognised by RIFF…WEBP', () => {
    expect(sniffImageType(webpWithEverything().file)).toBe('image/webp');
  });

  it('drops EXIF, XMP and ICCP and keeps the image chunks', () => {
    const { file, alph, vp8 } = webpWithEverything();
    const out = stripImageMetadata('image/webp', file);

    expect(text(out.subarray(0, 4))).toBe('RIFF');
    expect(text(out.subarray(8, 12))).toBe('WEBP');
    expect(has(out, 'EXIF')).toBe(false);
    expect(has(out, 'XMP ')).toBe(false);
    expect(has(out, 'ICCP')).toBe(false);
    expect(has(out, GPS_DEGREES)).toBe(false);
    expect(has(out, 'xmpmeta')).toBe(false);
    expect(has(out, alph)).toBe(true);
    expect(has(out, vp8)).toBe(true);
  });

  it('clears the VP8X flags for the sections it removed, and keeps the one it kept', () => {
    // A decoder told there is an EXIF section and then handed a file without
    // one is entitled to reject the whole thing, so this is not tidiness.
    const out = stripImageMetadata('image/webp', webpWithEverything().file);
    const flags = out[20]!;
    expect(flags & 0x08).toBe(0);   // EXIF
    expect(flags & 0x04).toBe(0);   // XMP
    expect(flags & 0x20).toBe(0);   // ICC
    expect(flags & 0x10).toBe(0x10);  // alpha, which is still true
  });

  it('rewrites the RIFF length to the file it actually produced', () => {
    const out = stripImageMetadata('image/webp', webpWithEverything().file);
    const stated = out[4]! + (out[5]! << 8) + (out[6]! << 16) + (out[7]! * 0x1000000);
    expect(stated).toBe(out.length - 8);
  });
});

// ---------------------------------------------------------------------------
// HEIC
// ---------------------------------------------------------------------------

const box = (type: string, body: Uint8Array) =>
  bytes(...be32(body.length + 8), type, body);

const IMAGE_ITEM = 1, EXIF_ITEM = 2;

/**
 * A minimal HEIF file: ftyp, a meta box whose iinf names an image item and an
 * EXIF item, an iloc pointing both of them into mdat, and an mdat holding the
 * two payloads.
 *
 * Built in two passes because iloc carries absolute file offsets and it sits
 * before the data it points at. The offsets are fixed-width, so the first pass
 * only needs to establish how long the boxes are.
 */
function heicWithExif() {
  const imageData = bytes('THE-ACTUAL-PICTURE-BYTES');
  const exifData = bytes(...be32(0), 'Exif', 0, 0, exifWithGps());

  const infe = (id: number, type: string) =>
    box('infe', bytes(2, 0, 0, 0, ...be16(id), ...be16(0), type, 0));

  const iinf = box('iinf', bytes(0, 0, 0, 0, ...be16(2),
    infe(IMAGE_ITEM, 'hvc1'), infe(EXIF_ITEM, 'Exif')));

  const iloc = (imageAt: number, exifAt: number) => box('iloc', bytes(
    1, 0, 0, 0,                                     // version 1
    0x44,                                           // offset_size 4, length_size 4
    0x00,                                           // base_offset_size 0, index_size 0
    ...be16(2),
    ...be16(IMAGE_ITEM), ...be16(0), ...be16(0), ...be16(1),
    ...be32(imageAt), ...be32(imageData.length),
    ...be16(EXIF_ITEM), ...be16(0), ...be16(0), ...be16(1),
    ...be32(exifAt), ...be32(exifData.length),
  ));

  const hdlr = box('hdlr', bytes(0, 0, 0, 0, ...be32(0), 'pict', ...new Array(12).fill(0), 0));
  const ftyp = box('ftyp', bytes('heic', ...be32(0), 'heic', 'mif1'));
  const meta = (a: number, b: number) => box('meta', bytes(0, 0, 0, 0, hdlr, iinf, iloc(a, b)));

  const mdatAt = ftyp.length + meta(0, 0).length;
  const imageAt = mdatAt + 8;
  const exifAt = imageAt + imageData.length;

  return {
    file: bytes(ftyp, meta(imageAt, exifAt),
      box('mdat', bytes(imageData, exifData))),
    imageAt, imageData, exifAt, exifLength: exifData.length,
  };
}

describe('HEIC', () => {
  it('is recognised by its ftyp brands', () => {
    expect(sniffImageType(heicWithExif().file)).toBe('image/heic');
    // The generic HEIF brand as major, with heic further down the list, which
    // is how plenty of encoders write it.
    const generic = bytes(...be32(24), 'ftyp', 'mif1', ...be32(0), 'mif1', 'heic');
    expect(sniffImageType(generic)).toBe('image/heic');
  });

  it('zeros the EXIF payload where iloc says it lives, and touches nothing else', () => {
    const { file, imageAt, imageData, exifAt, exifLength } = heicWithExif();
    const out = stripImageMetadata('image/heic', file);

    // Nothing is rebuilt, so nothing moves: same length, same box structure.
    expect(out.length).toBe(file.length);
    expect(out.subarray(0, imageAt)).toEqual(file.subarray(0, imageAt));

    // The picture is untouched.
    expect(out.subarray(imageAt, imageAt + imageData.length)).toEqual(imageData);

    // And the coordinates are gone, byte for byte.
    const wasExif = out.subarray(exifAt, exifAt + exifLength);
    expect([...wasExif].every((b) => b === 0)).toBe(true);
    expect(has(out, GPS_DEGREES)).toBe(false);
    expect(has(out.subarray(imageAt), 'Exif')).toBe(false);
  });

  it('leaves the EXIF item declared, which is what the comment says it does', () => {
    // Not an oversight and not a lesser bug: an HEIF file addresses its own
    // image data by absolute offset, so removing the `infe` and `iloc` entries
    // would shorten the boxes in front of the picture and move every offset
    // that points at it. The item stays declared and its bytes are zeros, and
    // this asserts that the honest version in images.ts is the true one rather
    // than a hedge nobody checked.
    const { file } = heicWithExif();
    const out = stripImageMetadata('image/heic', file);
    expect(has(out, 'infe')).toBe(true);
    expect(has(out, 'Exif')).toBe(true);       // the declaration, in iinf
  });

  it('does not touch the caller’s buffer', () => {
    const { file } = heicWithExif();
    const before = new Uint8Array(file);
    stripImageMetadata('image/heic', file);
    expect(file).toEqual(before);
  });

  it('hands back a file it cannot make sense of rather than damaging it', () => {
    // No meta box at all. The honest answer is to change nothing.
    const odd = bytes(box('ftyp', bytes('heic', ...be32(0), 'heic')),
      box('mdat', bytes('bytes')));
    expect(stripImageMetadata('image/heic', odd)).toEqual(odd);
  });
});

// ---------------------------------------------------------------------------
// The door itself
// ---------------------------------------------------------------------------

const upload = (d: Uint8Array, name = 'photo.jpg', type = 'image/jpeg') =>
  new File([d], name, { type });

describe('what gets through the upload gate', () => {
  const camera = { maxBytes: 6_000_000, allowed: CAMERA_IMAGE_TYPES };

  it('takes a real photo and hands back the stripped bytes', async () => {
    const { file } = jpegWithEverything();
    const out = await cleanImageUpload(upload(file), camera);
    expect(out.contentType).toBe('image/jpeg');
    expect(has(out.bytes, GPS_DEGREES)).toBe(false);
    expect(out.bytes.length).toBeLessThan(file.length);
  });

  it('believes the bytes over the header and the filename', async () => {
    // A PNG announced as a JPEG called photo.jpg. Both of those are typed by
    // the uploader; only the first eight bytes are not.
    const out = await cleanImageUpload(
      upload(pngWithEverything().file, 'photo.jpg', 'image/jpeg'), camera);
    expect(out.contentType).toBe('image/png');
  });

  it('refuses something that is not an image however it is labelled', async () => {
    const html = bytes('<!doctype html><script>alert(1)</script>');
    await expect(cleanImageUpload(upload(html, 'photo.jpg', 'image/jpeg'), camera))
      .rejects.toThrow(/not a photo we can store/i);
  });

  it('refuses an empty file', async () => {
    await expect(cleanImageUpload(upload(new Uint8Array(0)), camera))
      .rejects.toThrow(/empty|not a photo/i);
  });

  it('refuses a file over the cap without reading it', async () => {
    // A File knows its own size from the multipart framing, so this is decided
    // before anything is buffered. arrayBuffer() would throw if it were
    // reached, which is what makes this an assertion rather than a hope.
    const big = {
      size: 9_000_000,
      arrayBuffer: () => { throw new Error('the whole file was buffered'); },
    };
    Object.setPrototypeOf(big, File.prototype);
    await expect(cleanImageUpload(big, camera)).rejects.toThrow(/too big/i);
  });

  it('refuses a HEIC on the public profile, which a browser cannot render', async () => {
    const { file } = heicWithExif();
    await expect(cleanImageUpload(upload(file, 'x.heic', 'image/heic'),
      { maxBytes: 6_000_000, allowed: WEB_IMAGE_TYPES }))
      .rejects.toThrow(/not a photo we can store/i);
    // And takes the same file on a job, where an iPhone's default is the whole
    // reason the format is on the list.
    expect((await cleanImageUpload(upload(file, 'x.heic', 'image/heic'), camera)).contentType)
      .toBe('image/heic');
  });

  it('says the same thing to a wrong type as to an unreadable one', async () => {
    // A caller must not be able to learn which magic numbers get through by
    // reading the differences between refusals.
    const wrongType = cleanImageUpload(upload(heicWithExif().file), {
      maxBytes: 6_000_000, allowed: WEB_IMAGE_TYPES,
    }).catch((e) => e.message);
    const garbage = cleanImageUpload(upload(bytes('not an image at all')), {
      maxBytes: 6_000_000, allowed: WEB_IMAGE_TYPES,
    }).catch((e) => e.message);
    expect(await wrongType).toBe(await garbage);
  });

  it('refuses nothing at all', async () => {
    await expect(cleanImageUpload(null, camera)).rejects.toThrow(/no photo/i);
    await expect(cleanImageUpload('a string', camera)).rejects.toThrow(/no photo/i);
  });
});
