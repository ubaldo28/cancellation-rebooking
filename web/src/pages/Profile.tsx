import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api, photoUrl, type Operator, type WorkPhoto,
} from '../api';
import { ErrorNote, Spinner } from '../components/ui';
import { shrinkImage } from '../lib/image';
import { useDocumentTitle } from '../lib/title';

/**
 * The operator's own profile, at /app/profile.
 *
 * Everything here ends up on a page a stranger reads before deciding whether
 * to let this person into their driveway. The photos do most of that work, so
 * they get the most room.
 */

const BIO_MAX = 600;
/** Matches MAX_PHOTO_BYTES on the Worker. A looser number here just moves the
    rejection to after the upload, which on a phone is a minute wasted. */
const PHOTO_MAX_BYTES = 5_000_000;
/** Matches MAX_PHOTOS on the Worker. */
const PHOTO_MAX_COUNT = 12;
const ACCEPT = 'image/jpeg,image/png,image/webp';

/**
 * The profile columns live on the operator record. This intersection lets the
 * page read them whether or not they have reached the shared Operator type
 * yet, instead of failing to compile on someone else's change.
 */
type ProfileOperator = Operator & Partial<{
  tagline: string | null;
  bio: string | null;
  years_experience: number | null;
  profile_slug: string | null;
  slug: string | null;
  is_published: number;
}>;

const message = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;

export default function Profile() {
  useDocumentTitle('Your profile');
  const [photos, setPhotos] = useState<WorkPhoto[]>([]);
  const [tagline, setTagline] = useState('');
  const [bio, setBio] = useState('');
  const [years, setYears] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [published, setPublished] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { operator, photos } = await api.profile();
      const op = operator as ProfileOperator;
      setTagline(op.tagline ?? '');
      setBio(op.bio ?? '');
      setYears(op.years_experience === null || op.years_experience === undefined
        ? '' : String(op.years_experience));
      const s = op.profile_slug ?? op.slug ?? null;
      setSlug(s);
      // The slug survives unpublishing, so it cannot stand in for being live.
      setPublished(op.is_published === undefined ? Boolean(s) : op.is_published === 1);
      setPhotos(photos);
    } catch (e) {
      setError(message(e, 'Could not load your profile.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 2500);
  };

  async function save() {
    setSaving(true); setError(null);
    try {
      await api.saveProfile({
        tagline: tagline.trim(),
        bio: bio.trim(),
        years_experience: years.trim() ? Number(years) : undefined,
      });
      flash('Saved.');
    } catch (e) {
      setError(message(e, 'Could not save.'));
    } finally {
      setSaving(false);
    }
  }

  async function togglePublished() {
    setError(null);
    try {
      if (published) {
        await api.unpublishProfile();
        setPublished(false);
        flash('Your page is hidden.');
      } else {
        const res = await api.publishProfile();
        setSlug(res.slug);
        setPublished(true);
        flash('Your page is live.');
      }
    } catch (e) {
      setError(message(e, 'Could not change that.'));
    }
  }

  async function upload(file: File) {
    if (photos.length >= PHOTO_MAX_COUNT) {
      setError(`You can show ${PHOTO_MAX_COUNT} photos. Delete one to make room.`);
      return;
    }
    // Checked here, before the upload, because a rejection after a slow
    // upload on a phone connection is the worst way to learn about a limit.
    if (!ACCEPT.split(',').includes(file.type)) {
      setError('That file has to be a JPEG, PNG or WebP.');
      return;
    }
    setUploading(true); setError(null);
    try {
      // Shrunk on this phone before it goes anywhere. A camera original is
      // 3-5 MB and is never shown above about 1200px, so uploading it wastes
      // the operator's data on a van's signal and storage charged by the
      // gigabyte. This also means a photo straight off a modern camera stops
      // failing the 5 MB limit for no reason the operator can understand.
      const { file: small } = await shrinkImage(file);
      if (small.size > PHOTO_MAX_BYTES) {
        setError(`That photo is still ${(small.size / 1024 / 1024).toFixed(1)} MB after `
          + 'shrinking. Try a different one.');
        return;
      }
      const { photo } = await api.uploadPhoto(small);
      setPhotos((list) => [...list, photo]);
    } catch (e) {
      setError(message(e, 'Could not upload that photo.'));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';  // same file can be retried
    }
  }

  async function remove(id: string) {
    const before = photos;
    setPhotos(photos.filter((p) => p.id !== id));
    try {
      await api.deletePhoto(id);
    } catch (e) {
      setPhotos(before);
      setError(message(e, 'Could not delete that photo.'));
    }
  }

  async function move(index: number, by: -1 | 1) {
    const to = index + by;
    if (to < 0 || to >= photos.length) return;
    const next = [...photos];
    const a = next[index], b = next[to];
    if (!a || !b) return;
    next[index] = b; next[to] = a;
    const before = photos;
    setPhotos(next);
    try {
      const res = await api.reorderPhotos(next.map((p) => p.id));
      setPhotos(res.photos);
    } catch (e) {
      setPhotos(before);
      setError(message(e, 'Could not reorder the photos.'));
    }
  }

  if (loading) {
    return (
      <>
        <header className="page-head"><h1>Your profile</h1></header>
        <Spinner label="Loading your profile" />
      </>
    );
  }

  const publicUrl = published && slug ? `${window.location.origin}/p/${slug}` : null;

  return (
    <>
      <header className="page-head">
        <h1>Your profile</h1>
        <span className="muted">What a customer sees before they book.</span>
      </header>

      <main className="main stack-lg">
        {error && <ErrorNote error={error} onRetry={load} />}
        {notice && <div className="notice">{notice}</div>}

        <section className="stack">
          <span className="eyebrow">Published</span>
          <div className="card stack">
            {publicUrl ? (
              <>
                <span className="name" style={{ fontSize: 15 }}>Your page is live</span>
                <a href={publicUrl} className="mono" style={{ fontSize: 13, wordBreak: 'break-all' }}>
                  {publicUrl}
                </a>
              </>
            ) : (
              <>
                <span className="name" style={{ fontSize: 15 }}>Your page is hidden</span>
                <span className="muted">
                  Nobody can open it. Publish it and you get a link you can send.
                </span>
              </>
            )}
            <button className="btn quiet block" onClick={() => { void togglePublished(); }}>
              {published ? 'Hide my page' : 'Publish my page'}
            </button>
          </div>
        </section>

        <section className="stack">
          <span className="eyebrow">About you</span>

          <label className="card" style={{ padding: 14 }}>
            One line about what you do
            <input value={tagline} maxLength={120}
              onChange={(e) => setTagline(e.target.value)}
              placeholder="Mobile detailing across the west side" />
            <span className="faint">This sits under your business name.</span>
          </label>

          <label className="card" style={{ padding: 14 }}>
            Longer description
            <textarea value={bio} maxLength={BIO_MAX} rows={6}
              onChange={(e) => setBio(e.target.value)}
              placeholder="What you do, what you bring, how you work." />
            <span className="faint">
              Shown to customers on your public page. {bio.length} of {BIO_MAX} characters.
            </span>
          </label>

          <label className="card" style={{ padding: 14 }}>
            Years doing this
            <input type="number" min="0" max="80" value={years}
              onChange={(e) => setYears(e.target.value)} placeholder="6" />
            <span className="faint">Leave it blank if you would rather not say.</span>
          </label>

          <button className="btn block" onClick={() => { void save(); }} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </section>

        <section className="stack">
          <span className="eyebrow">Photos of your work</span>

          {photos.length === 0 ? (
            <div className="blank">
              No photos yet. A stranger deciding whether to let you onto their
              driveway is looking for finished work, not words. Add a few
              before and after shots of jobs you are happy with.
            </div>
          ) : (
            <div className="photo-grid">
              {photos.map((p, i) => (
                <figure className="photo-cell" key={p.id}>
                  <img src={photoUrl(p.r2_key)} alt={p.caption ?? 'Finished work'} loading="lazy" />
                  <div className="photo-ops">
                    <button type="button" aria-label="Move earlier"
                      disabled={i === 0} onClick={() => { void move(i, -1); }}>↑</button>
                    <button type="button" aria-label="Move later"
                      disabled={i === photos.length - 1} onClick={() => { void move(i, 1); }}>↓</button>
                    <button type="button" className="danger" aria-label="Delete photo"
                      onClick={() => { void remove(p.id); }}>Delete</button>
                  </div>
                  {p.caption && <figcaption>{p.caption}</figcaption>}
                </figure>
              ))}
            </div>
          )}

          <button type="button" className="btn ghost block"
            disabled={uploading || photos.length >= PHOTO_MAX_COUNT}
            onClick={() => fileInput.current?.click()}>
            {uploading ? 'Uploading…' : 'Add a photo'}
          </button>
          <input ref={fileInput} type="file" accept={ACCEPT} hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }} />
          <span className="faint">
            JPEG, PNG or WebP, up to 5 MB each.{' '}
            {photos.length >= PHOTO_MAX_COUNT
              ? `You are at the limit of ${PHOTO_MAX_COUNT}.`
              : `${photos.length} of ${PHOTO_MAX_COUNT} used.`}
          </span>
        </section>
      </main>
    </>
  );
}
