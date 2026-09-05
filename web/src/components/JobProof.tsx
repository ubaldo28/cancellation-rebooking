import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type JobPhoto, type Stage } from '../api';
import '../styles-parts.css';

/**
 * Before / during / after photos on one booking, from whichever side is
 * looking at it.
 *
 * Both sides upload, because both sides have something to lose: the operator
 * against "they never turned up" on a job they did, the customer against "the
 * work was done" on a job nobody came to. A one-sided camera is not evidence,
 * it is one person's account with pictures attached.
 *
 * The photos are private to the two people on this booking. There is no public
 * URL — every image is fetched through an authorised endpoint — because these
 * are pictures of somebody's home, and a shareable link to one would outlive
 * every reason it was taken.
 */

const STAGES: Array<{ key: Stage; label: string; hint: string }> = [
  { key: 'before', label: 'Before', hint: 'How it looked when they arrived' },
  { key: 'during', label: 'During', hint: 'The work in progress' },
  { key: 'after', label: 'After', hint: 'How it was left' },
];

/**
 * Shrinks a photo before it is sent.
 *
 * A modern phone camera produces 4–12MB per shot, and a mobile operator
 * uploading three of those on a driveway with one bar is an upload that fails
 * and a feature nobody uses. 1600px is far more than enough to show whether a
 * car was washed, and it turns a 9MB file into roughly 300KB.
 */
async function shrink(file: File, max = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b ?? file), 'image/jpeg', 0.82);
  });
}

export default function JobProof(
  { orderItemId, token, disabled }:
  { orderItemId: string; token?: string; disabled?: boolean },
) {
  const [photos, setPhotos] = useState<JobPhoto[]>([]);
  const [busy, setBusy] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const inputs = useRef<Partial<Record<Stage, HTMLInputElement | null>>>({});

  const load = useCallback(async () => {
    try {
      const res = token
        ? await api.guestProof(token, orderItemId)
        : await api.jobProof(orderItemId);
      setPhotos([...res.before, ...res.during, ...res.after]);
    } catch {
      // A proof strip that will not load is not worth an error box over the
      // booking it belongs to. The next open will pick it up.
    } finally { setLoaded(true); }
  }, [orderItemId, token]);

  useEffect(() => { void load(); }, [load]);

  const upload = async (stage: Stage, file: File) => {
    setBusy(stage); setError(null);
    try {
      const blob = await shrink(file);
      const form = new FormData();
      form.append('file', new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
      form.append('stage', stage);
      if (token) await api.guestAddProof(token, orderItemId, form);
      else await api.addJobProof(orderItemId, form);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That photo did not upload.');
    } finally { setBusy(null); }
  };

  if (!loaded) return null;

  const src = (p: JobPhoto) => (token
    ? `/api/public/threads/${encodeURIComponent(token)}/photo/${p.id}`
    : `/api/proof/${p.id}`);

  return (
    <section className="proof">
      <div className="proof-head">
        <span className="muted">Photos of the job</span>
        <span className="faint">
          Only you and the other side can see these.
        </span>
      </div>

      {STAGES.map((s) => {
        const mine = photos.filter((p) => p.stage === s.key);
        return (
          <div key={s.key} className="proof-stage">
            <div className="proof-stage-head">
              <strong>{s.label}</strong>
              <span className="faint">{s.hint}</span>
            </div>

            <div className="proof-strip">
              {mine.map((p) => (
                <a key={p.id} className="proof-thumb" href={src(p)}
                  target="_blank" rel="noreferrer">
                  <img src={src(p)} alt={`${s.label} photo`} loading="lazy" />
                </a>
              ))}

              {!disabled && (
                <>
                  {/* capture="environment" opens the rear camera straight
                      away on a phone rather than a file picker. On a job,
                      that is the difference between one tap and four. */}
                  <input
                    ref={(el) => { inputs.current[s.key] = el; }}
                    type="file" accept="image/*" capture="environment" hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) void upload(s.key, f);
                    }}
                  />
                  <button type="button" className="proof-add"
                    disabled={busy === s.key}
                    onClick={() => inputs.current[s.key]?.click()}>
                    {busy === s.key ? '…' : '+'}
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}

      {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
    </section>
  );
}
