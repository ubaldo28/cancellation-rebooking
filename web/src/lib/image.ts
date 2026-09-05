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
 */

const MAX_EDGE = 1600;
const QUALITY = 0.82;

/** Browsers that cannot encode WebP fall back to JPEG, which all of them can. */
async function bestType(): Promise<'image/webp' | 'image/jpeg'> {
  if (typeof document === 'undefined') return 'image/jpeg';
  const probe = document.createElement('canvas');
  probe.width = 1; probe.height = 1;
  return probe.toDataURL('image/webp').startsWith('data:image/webp')
    ? 'image/webp' : 'image/jpeg';
}

export interface Shrunk { file: File; width: number; height: number }

export async function shrinkImage(file: File): Promise<Shrunk> {
  // A file the browser cannot decode is passed through untouched rather than
  // failing the upload: the server still checks type and size.
  if (!file.type.startsWith('image/')) {
    return { file, width: 0, height: 0 };
  }

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return { file, width: 0, height: 0 };

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) { bitmap.close(); return { file, width: bitmap.width, height: bitmap.height }; }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const type = await bestType();
  const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, type, QUALITY));
  if (!blob) return { file, width, height };

  // If re-encoding somehow made it bigger — a small PNG screenshot can do this
  // — keep the original. The point is fewer bytes, not more work.
  if (blob.size >= file.size) return { file, width, height };

  const name = file.name.replace(/\.[^.]+$/, '') + (type === 'image/webp' ? '.webp' : '.jpg');
  return { file: new File([blob], name, { type }), width, height };
}
