import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Every migration, in order, read from the directory.
 *
 * Each test file used to carry its own hand-typed copy of this list. Adding a
 * migration therefore meant editing thirteen files, and the failure mode when
 * one was missed was not a clear "you forgot a file" -- it was thirty-odd
 * unrelated tests failing deep inside library code with "no such column",
 * which reads like a bug in the feature rather than a stale fixture.
 *
 * Reading the directory means a new migration is picked up by every test the
 * moment it exists, and the schema under test is by definition the schema that
 * ships. The sort is what makes it an ordering rather than a set: these files
 * are numbered precisely because 0012 rebuilds a table 0010 created, and
 * running them in the filesystem's own order would be running them at random.
 */
export const ALL_MIGRATIONS: string[] = (() => {
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => dir + f);
})();

// Vite rewrites a static `node:sqlite` import into a bare specifier it cannot
// resolve, so reach the builtin through the runtime instead.
const { DatabaseSync } = (process as any).getBuiltinModule('node:sqlite') as {
  DatabaseSync: new (path: string) => any;
};
type DatabaseSync = any;

/**
 * Minimal D1 shim over node:sqlite, good enough to run the Worker's real
 * queries in tests. batch() runs inside a transaction and rolls back on any
 * failure, which is what D1 does — that is the behaviour the accept-race
 * guarantee depends on, so faking it would make the test worthless.
 */
class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) { return new Stmt(this.db, this.sql, args); }

  private norm(a: unknown[]) {
    return a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  }
  private isRead() { return /^\s*(select|pragma|with)/i.test(this.sql); }

  run() {
    const s = this.db.prepare(this.sql);
    if (this.isRead()) {
      const rows = s.all(...(this.norm(this.args) as any));
      return { success: true, results: rows, meta: { changes: 0, last_row_id: 0 } };
    }
    const r = s.run(...(this.norm(this.args) as any));
    return {
      success: true,
      meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) },
    };
  }
  first<T = any>(): T | null {
    const rows = this.db.prepare(this.sql).all(...(this.norm(this.args) as any)) as T[];
    return rows.length ? rows[0]! : null;
  }
  all<T = any>() {
    const rows = this.db.prepare(this.sql).all(...(this.norm(this.args) as any)) as T[];
    return { success: true, results: rows, meta: { changes: 0 } };
  }
  raw() { return this.all().results; }
}

export class FakeD1 {
  public db: DatabaseSync;
  constructor(migrationPaths: string | string[]) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON;');
    for (const p of Array.isArray(migrationPaths) ? migrationPaths : [migrationPaths]) {
      this.db.exec(readFileSync(p, 'utf8'));
    }
  }
  prepare(sql: string) { return new Stmt(this.db, sql) as any; }
  async batch(stmts: any[]) {
    this.db.exec('BEGIN');
    try {
      const out = stmts.map((s) => s.run());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(sql: string) { this.db.exec(sql); return { count: 0, duration: 0 }; }
}

export function makeEnv(migrationPaths: string | string[]) {
  return {
    DB: new FakeD1(migrationPaths) as any,
    APP_URL: 'https://gap.test',
    DISTANCE_PROVIDER: 'estimate' as const,
    GEOCODE_PROVIDER: 'none' as const,
    SESSION_PEPPER: 'test-pepper-value-0123456789',
  };
}
