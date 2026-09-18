import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, FakeD1 } from './d1';

/**
 * The schema, and the code that is supposed to be reading it.
 *
 * Two things are checked here that nothing else can check. The first is that
 * every migration in the directory applies, in order, to an empty database —
 * every other test file gets that for free by building its fixture the same
 * way, but none of them says so, and "the suite went red in thirty places" is
 * a poor way to find out that 0035 has a typo in it.
 *
 * The second is the one that rots quietly: a column that nothing reads. Every
 * such column is either dead weight or a feature that was half-wired and left,
 * and the difference is invisible from the schema. Both have happened here —
 * order_items.vehicle_reported_note took a customer's own account of what
 * happened on their doorstep and put it somewhere no screen and no endpoint
 * could reach, and order_items.address_released_at recorded that a cancelled
 * booking's address should stop being shown while the schedule went on showing
 * it. So the rule is: read it, or say in the migration why not.
 */

/**
 * Every Worker source file, as one string to search.
 *
 * Walked from this file's own location rather than from a path typed into the
 * test or from `process.cwd()`. The first spelling of this shelled out to
 * `find` against an absolute path from the machine it was written on, so the
 * suite passed there and failed on every other computer with "No such file or
 * directory" — a test that depends on where it happens to be checked out is
 * not a test. `import.meta.url` is the one thing that is true wherever the
 * repository sits, and reading the directory directly is both faster than a
 * subprocess and works the same on Windows.
 */
function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

const SRC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

const SRC = tsFilesUnder(SRC_DIR)
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

/**
 * Columns the Worker deliberately does not read, and the migration that says
 * so in as many words.
 *
 * Adding to this list is a decision, not a formality. Dropping a column costs
 * a migration against a live database and a table rebuild in SQLite, so a
 * column that turned out to be unnecessary is usually cheaper to document than
 * to remove — but it has to be documented where somebody reading the schema
 * will find it, which is beside the column and nowhere else.
 */
const UNWIRED: Record<string, string> = {
  'appointments.external_id': '0001_init.sql',
  'locations.is_primary': '0001_init.sql',
  'messages.cost_cents': '0001_init.sql',
  // All three were written by the inbound and status webhooks behind an
  // operator's own carrier account. That feature is gone; the columns are
  // documented in place rather than dropped, because dropping one in SQLite
  // rebuilds the table.
  'messages.from_address': '0001_init.sql',
  'messages.provider_sid': '0001_init.sql',
  'messages.error_code': '0001_init.sql',
  'services.is_price_from': '0001_init.sql',
  'postal_codes.admin_name1': '0002_postal_codes.sql',
  // clients.platform_introduced WAS HERE and no longer belongs. 0023 added it
  // marked READ BY NOTHING and asked that a reader be recorded; the erasure in
  // lib/retention.ts is now that reader — it is how a customer's row is told
  // apart from an operator's own imported one — and migration 0048 is where it
  // is recorded. A column listed as unread while something reads it is the
  // list lying, which is worse than not having one.
};

/** Every table and column the migrations actually produce. */
function schema(): Array<{ table: string; column: string }> {
  const db = new FakeD1(ALL_MIGRATIONS).db;
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`,
  ).all() as Array<{ name: string }>;
  return tables.flatMap((t) =>
    (db.prepare(`PRAGMA table_info(${t.name})`).all() as Array<{ name: string }>)
      .map((c) => ({ table: t.name, column: c.name })));
}

describe('the migrations', () => {
  it('all apply, in order, to an empty database', () => {
    // FakeD1 execs each file in turn and throws on the first failure, so the
    // construction is the assertion. The count guards against a directory read
    // that quietly matched nothing.
    expect(ALL_MIGRATIONS.length).toBeGreaterThan(30);
    expect(schema().length).toBeGreaterThan(200);
  });

  it('are numbered in the order they have to run in', () => {
    const names = ALL_MIGRATIONS.map((p) => p.split('/').pop()!);
    // The sort in d1.ts is what makes reading the directory an ordering rather
    // than a set — 0012 rebuilds a table 0010 created. That only holds while
    // every file is numbered with the same width.
    for (const n of names) expect(n, n).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    expect([...names].sort()).toEqual(names);
  });
});

describe('every column the schema defines', () => {
  it('is named somewhere in the Worker, or is documented as unread', () => {
    const orphans: string[] = [];
    for (const { table, column } of schema()) {
      if (new RegExp(`\\b${column}\\b`).test(SRC)) continue;
      if (UNWIRED[`${table}.${column}`]) continue;
      orphans.push(`${table}.${column}`);
    }
    // A new column nothing reads is either dead or half-wired. Wire it, or add
    // it to UNWIRED above with a note in its own migration saying why.
    expect(orphans).toEqual([]);
  });

  it('has not left the unread list describing columns that no longer exist', () => {
    const present = new Set(schema().map((c) => `${c.table}.${c.column}`));
    for (const key of Object.keys(UNWIRED)) expect(present.has(key), key).toBe(true);
  });

  it('has a migration explaining each one that is unread', () => {
    for (const [key, file] of Object.entries(UNWIRED)) {
      const column = key.split('.')[1]!;
      const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
      const at = sql.indexOf(column);
      expect(at, `${key} is not in ${file}`).toBeGreaterThan(-1);
      // The explanation sits beside the column — above it for a single line,
      // above the table for one that is about the whole table — which is where
      // somebody reading the schema will be looking.
      // Comment markers and line breaks are flattened first, because these
      // notes wrap and the phrase that matters lands across two lines as often
      // as not.
      const near = sql.slice(Math.max(0, at - 900), at + 900)
        .replace(/^\s*--\s?/gm, '').replace(/\s+/g, ' ');
      expect(near, `${key} is unread and ${file} does not say why`)
        .toMatch(/NOT WIRED|READ BY NOTHING|NOTHING IN THE APP CREATES|unreachable/i);
    }
  });

  it('still reads the two columns that were being written into a void', () => {
    // Both of these were written on every use and read by nothing: a
    // customer's account of a van that did not match, and the record that a
    // cancelled booking's address should no longer be shown. They are the
    // reason this file exists, so they are named rather than merely covered.
    for (const column of ['vehicle_reported_note', 'vehicle_reported_at',
      'address_released_at']) {
      expect(new RegExp(`SELECT[\\s\\S]{0,600}?\\b${column}\\b`).test(SRC), column).toBe(true);
    }
  });
});
