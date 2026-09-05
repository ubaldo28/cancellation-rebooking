import { describe, expect, it, beforeEach } from 'vitest';
import { ALL_MIGRATIONS, makeEnv } from './d1';
import type { Env } from '../src/types';
import {
  addPhoto, deletePhoto, ensureProfileSlug, getPublicProfile, listPhotos,
  reorderPhotos, slugify,
} from '../src/lib/profile';
import { now } from '../src/lib/util';

const MIGRATIONS = ALL_MIGRATIONS;

let env: Env;

/** One operator. Nothing public until a test says so. */
async function makeOperator(id: string, businessName: string, opts: {
  published?: boolean; email?: string;
} = {}) {
  const n = now();
  await env.DB.prepare(
    `INSERT INTO operators (id,email,business_name,trade,phone_e164,timezone,country,
       currency,language,location_mode,fill_model,sms_mode,plan,is_published,
       tagline,bio,years_experience,created_at,updated_at)
     VALUES (?,?,?, 'mobile car wash and detailing','+18185550100','America/Los_Angeles','US','USD','en',
       'mobile','both','device','active',?,?,?,?,?,?)`,
  ).bind(id, opts.email ?? `${id}@x.com`, businessName,
    opts.published ? 1 : 0,
    'Paint correction and ceramic coating',
    'Fifteen years of it, mostly in the Valley.',
    15, n, n).run();
}

const photo = (over: Record<string, unknown> = {}) => ({
  r2_key: `k/${Math.random().toString(36).slice(2)}`,
  content_type: 'image/jpeg',
  bytes: 400_000,
  ...over,
});

beforeEach(() => {
  env = makeEnv(MIGRATIONS) as unknown as Env;
});

describe('slugify', () => {
  it('turns a business name into a URL segment', () => {
    expect(slugify('Valley Detailing')).toBe('valley-detailing');
  });

  it('drops punctuation instead of encoding it', () => {
    expect(slugify("Dave's Plumbing & Heating, Ltd.")).toBe('dave-s-plumbing-heating-ltd');
  });

  it('folds accents rather than deleting the letters under them', () => {
    // "caf-mvil" is not a name its owner would ever recognise as theirs.
    expect(slugify('Café Móvil')).toBe('cafe-movil');
    expect(slugify('Über Räder')).toBe('uber-rader');
  });

  it('leaves an already slug-like name alone', () => {
    expect(slugify('valley-detailing')).toBe('valley-detailing');
  });

  it('collapses runs of separators and trims the ends', () => {
    expect(slugify('  ---Valley   ///  Detailing!!!  ')).toBe('valley-detailing');
  });

  it('trims to 60 characters without leaving a trailing hyphen', () => {
    const s = slugify('A'.repeat(30) + ' ' + 'B'.repeat(40));
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith('-')).toBe(false);
  });

  it('returns an empty string when there is nothing usable left', () => {
    expect(slugify('！！！')).toBe('');
  });
});

describe('ensureProfileSlug', () => {
  it('gives an operator the slug of their business name', async () => {
    await makeOperator('op1', 'Valley Detailing');
    expect(await ensureProfileSlug(env, 'op1', 'Valley Detailing')).toBe('valley-detailing');
  });

  it('is idempotent — a second call returns the same slug and mints nothing new', async () => {
    await makeOperator('op1', 'Valley Detailing');
    const first = await ensureProfileSlug(env, 'op1', 'Valley Detailing');
    const second = await ensureProfileSlug(env, 'op1', 'Valley Detailing');
    expect(second).toBe(first);

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM operators WHERE profile_slug IS NOT NULL`,
    ).first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it('keeps the slug an operator already has, even after a rename', async () => {
    await makeOperator('op1', 'Valley Detailing');
    await ensureProfileSlug(env, 'op1', 'Valley Detailing');
    // The link is already printed on the van; renaming the business must not
    // break it.
    expect(await ensureProfileSlug(env, 'op1', 'Sunset Detailing')).toBe('valley-detailing');
  });

  it('gives two businesses with the same name different public URLs', async () => {
    await makeOperator('op1', 'Valley Detailing');
    await makeOperator('op2', 'Valley Detailing');
    const a = await ensureProfileSlug(env, 'op1', 'Valley Detailing');
    const b = await ensureProfileSlug(env, 'op2', 'Valley Detailing');
    expect(a).toBe('valley-detailing');
    expect(b).toBe('valley-detailing-2');
    expect(a).not.toBe(b);
  });

  it('keeps counting past the first collision', async () => {
    for (const id of ['op1', 'op2', 'op3']) await makeOperator(id, 'Valley Detailing');
    const slugs = [];
    for (const id of ['op1', 'op2', 'op3']) {
      slugs.push(await ensureProfileSlug(env, id, 'Valley Detailing'));
    }
    expect(slugs).toEqual(['valley-detailing', 'valley-detailing-2', 'valley-detailing-3']);
    expect(new Set(slugs).size).toBe(3);
  });

  it('still produces a usable slug for a name with no ASCII in it', async () => {
    await makeOperator('op1', '！！！');
    expect(await ensureProfileSlug(env, 'op1', '！！！')).toBe('operator');
  });

  it('refuses an operator that does not exist', async () => {
    await expect(ensureProfileSlug(env, 'nobody', 'Valley Detailing')).rejects.toThrow();
  });
});

describe('the public profile', () => {
  async function published(id = 'op1', name = 'Valley Detailing') {
    await makeOperator(id, name, { published: true });
    return ensureProfileSlug(env, id, name);
  }

  it('shows a published operator', async () => {
    const slug = await published();
    const p = await getPublicProfile(env, slug);
    expect(p).not.toBeNull();
    expect(p!.operator.business_name).toBe('Valley Detailing');
    expect(p!.operator.years_experience).toBe(15);
    expect(p!.operator.trade).toBe('mobile car wash and detailing');
  });

  it('hides an operator who has not published', async () => {
    await makeOperator('op1', 'Valley Detailing');           // is_published = 0
    const slug = await ensureProfileSlug(env, 'op1', 'Valley Detailing');
    expect(await getPublicProfile(env, slug)).toBeNull();
  });

  it('disappears again the moment an operator unpublishes', async () => {
    const slug = await published();
    await env.DB.prepare(`UPDATE operators SET is_published = 0 WHERE id = 'op1'`).run();
    expect(await getPublicProfile(env, slug)).toBeNull();
  });

  it('returns null for a slug nobody owns', async () => {
    await published();
    expect(await getPublicProfile(env, 'no-such-business')).toBeNull();
    expect(await getPublicProfile(env, '')).toBeNull();
  });

  it('never leaks contact details or account settings', async () => {
    const slug = await published();
    const p = await getPublicProfile(env, slug);
    const keys = Object.keys(p!.operator);
    for (const leaked of ['email', 'phone_e164', 'phone', 'plan', 'id',
                          'max_detour_seconds', 'discount_percent', 'deposit_cents',
                          'home_address', 'home_lat', 'home_lng', 'trial_ends_at']) {
      expect(keys).not.toContain(leaked);
    }
    // And nothing that merely looks like a contact detail slipped through.
    expect(JSON.stringify(p!.operator)).not.toContain('op1@x.com');
    expect(JSON.stringify(p!.operator)).not.toContain('+18185550100');
    // The exact allow-list, and it is meant to be annoying to change: every
    // field added to the public payload has to be looked at once, on purpose,
    // by somebody asking whether a stranger should see it. That is the whole
    // value of asserting the full set rather than only the known-bad names.
    expect(keys.sort()).toEqual([
      'avatar_key',
      'background_check_name', 'background_check_provider', 'background_checked_at',
      'bio', 'business_name', 'country', 'currency', 'employees', 'hired_count',
      'language', 'payment_methods',
      'social_facebook', 'social_instagram', 'social_tiktok',
      'tagline', 'timezone', 'trade', 'work_location',
      'years_experience', 'years_in_business',
    ]);
  });

  it('carries the operator’s photos in their chosen order', async () => {
    const slug = await published();
    const a = await addPhoto(env, 'op1', photo({ caption: 'first' }));
    const b = await addPhoto(env, 'op1', photo({ caption: 'second' }));
    await reorderPhotos(env, 'op1', [b.id, a.id]);
    const p = await getPublicProfile(env, slug);
    expect(p!.photos.map((x) => x.caption)).toEqual(['second', 'first']);
  });

  it('shows only its own operator’s photos', async () => {
    const slug = await published('op1', 'Valley Detailing');
    await makeOperator('op2', 'Sunset Detailing', { published: true });
    await addPhoto(env, 'op1', photo({ caption: 'mine' }));
    await addPhoto(env, 'op2', photo({ caption: 'theirs' }));
    const p = await getPublicProfile(env, slug);
    expect(p!.photos).toHaveLength(1);
    expect(p!.photos[0]!.caption).toBe('mine');
  });
});

describe('work photos', () => {
  beforeEach(async () => {
    await makeOperator('op1', 'Valley Detailing', { published: true });
    await makeOperator('op2', 'Sunset Detailing', { published: true });
  });

  it('appends each new photo after the ones already there', async () => {
    const a = await addPhoto(env, 'op1', photo());
    const b = await addPhoto(env, 'op1', photo());
    expect(a.sort_order).toBe(0);
    expect(b.sort_order).toBe(1);
    expect((await listPhotos(env, 'op1')).map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it('lists only that operator’s photos', async () => {
    await addPhoto(env, 'op1', photo());
    await addPhoto(env, 'op2', photo());
    expect(await listPhotos(env, 'op1')).toHaveLength(1);
    expect(await listPhotos(env, 'op2')).toHaveLength(1);
  });

  it('stops at twelve photos', async () => {
    for (let i = 0; i < 12; i++) await addPhoto(env, 'op1', photo());
    await expect(addPhoto(env, 'op1', photo())).rejects.toThrow(/12 photos|Remove one/i);
    expect(await listPhotos(env, 'op1')).toHaveLength(12);
    // The limit is per operator, not global.
    await expect(addPhoto(env, 'op2', photo())).resolves.toBeTruthy();
  });

  it('refuses anything that is not a JPEG, PNG or WebP', async () => {
    for (const ct of ['image/gif', 'image/svg+xml', 'application/pdf', 'text/html', '']) {
      await expect(addPhoto(env, 'op1', photo({ content_type: ct })))
        .rejects.toThrow(/JPEG, PNG or WebP/i);
    }
    await expect(addPhoto(env, 'op1', photo({ content_type: 'image/png' })))
      .resolves.toBeTruthy();
    await expect(addPhoto(env, 'op1', photo({ content_type: 'image/webp' })))
      .resolves.toBeTruthy();
    expect(await listPhotos(env, 'op1')).toHaveLength(2);
  });

  it('refuses a photo over 5 MB', async () => {
    await expect(addPhoto(env, 'op1', photo({ bytes: 5_000_001 })))
      .rejects.toThrow(/5 MB/i);
    await expect(addPhoto(env, 'op1', photo({ bytes: 5_000_000 })))
      .resolves.toBeTruthy();
    expect(await listPhotos(env, 'op1')).toHaveLength(1);
  });

  it('refuses a row with no object behind it', async () => {
    await expect(addPhoto(env, 'op1', photo({ r2_key: '  ' }))).rejects.toThrow();
  });

  it('deletes a photo and hands back the key so the object can go too', async () => {
    const p = await addPhoto(env, 'op1', photo());
    const { r2_key } = await deletePhoto(env, 'op1', p.id);
    expect(r2_key).toBe(p.r2_key);
    expect(await listPhotos(env, 'op1')).toHaveLength(0);
  });

  it('will not let one operator delete another’s photo', async () => {
    const theirs = await addPhoto(env, 'op2', photo({ caption: 'theirs' }));
    await expect(deletePhoto(env, 'op1', theirs.id)).rejects.toThrow(/not on your profile/i);
    // Still there, untouched.
    const still = await listPhotos(env, 'op2');
    expect(still).toHaveLength(1);
    expect(still[0]!.id).toBe(theirs.id);
  });

  it('reports a stranger’s photo id exactly as it reports a made-up one', async () => {
    const theirs = await addPhoto(env, 'op2', photo());
    const a = await deletePhoto(env, 'op1', theirs.id).catch((e) => String(e));
    const b = await deletePhoto(env, 'op1', 'no-such-photo').catch((e) => String(e));
    expect(a).toBe(b);
  });

  it('applies the operator’s order', async () => {
    const a = await addPhoto(env, 'op1', photo({ caption: 'a' }));
    const b = await addPhoto(env, 'op1', photo({ caption: 'b' }));
    const c = await addPhoto(env, 'op1', photo({ caption: 'c' }));
    const out = await reorderPhotos(env, 'op1', [c.id, a.id, b.id]);
    expect(out.map((p) => p.caption)).toEqual(['c', 'a', 'b']);
    expect(out.map((p) => p.sort_order)).toEqual([0, 1, 2]);
  });

  it('keeps photos the operator left out, after the ones they named', async () => {
    const a = await addPhoto(env, 'op1', photo({ caption: 'a' }));
    const b = await addPhoto(env, 'op1', photo({ caption: 'b' }));
    const c = await addPhoto(env, 'op1', photo({ caption: 'c' }));
    const out = await reorderPhotos(env, 'op1', [c.id]);
    expect(out.map((p) => p.caption)).toEqual(['c', 'a', 'b']);
    expect(out).toHaveLength(3);
    expect(out.map((p) => p.id).sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it('ignores ids that belong to somebody else', async () => {
    const mine = await addPhoto(env, 'op1', photo({ caption: 'mine' }));
    const theirs = await addPhoto(env, 'op2', photo({ caption: 'theirs' }));
    const out = await reorderPhotos(env, 'op1', [theirs.id, mine.id]);
    expect(out.map((p) => p.id)).toEqual([mine.id]);
    // Their photo did not move, and did not join our list.
    const other = await listPhotos(env, 'op2');
    expect(other).toHaveLength(1);
    expect(other[0]!.sort_order).toBe(theirs.sort_order);
  });

  it('survives an empty reorder', async () => {
    const a = await addPhoto(env, 'op1', photo({ caption: 'a' }));
    expect((await reorderPhotos(env, 'op1', [])).map((p) => p.id)).toEqual([a.id]);
  });

  it('takes an operator’s photos with them when the account is deleted', async () => {
    await addPhoto(env, 'op1', photo());
    await env.DB.prepare(`DELETE FROM operators WHERE id = 'op1'`).run();
    expect(await listPhotos(env, 'op1')).toHaveLength(0);
  });
});
