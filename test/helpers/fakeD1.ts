// A D1Database-compatible adapter backed by Node's built-in SQLite (node:sqlite). Faithful enough
// to run the real db.ts helpers + engine against an in-memory database, so idempotency/retry logic
// is exercised end-to-end without a live Worker.

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

// node:sqlite is a new builtin the bundler doesn't recognize; load it at runtime via require so
// Vite/esbuild never tries to resolve it as a file. The type import above is erased at compile time.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

type Stmt = ReturnType<DatabaseSyncType["prepare"]>;

class FakeStmt {
  private params: unknown[] = [];
  constructor(private readonly stmt: Stmt) {}
  bind(...args: unknown[]): FakeStmt {
    this.params = args;
    return this;
  }
  async run(): Promise<{ meta: { changes: number } }> {
    const r = this.stmt.run(...(this.params as never[]));
    return { meta: { changes: Number(r.changes) } };
  }
  async first<T = unknown>(): Promise<T | null> {
    const row = this.stmt.get(...(this.params as never[]));
    return (row ?? null) as T | null;
  }
  async all<T = unknown>(): Promise<{ results: T[] }> {
    const rows = this.stmt.all(...(this.params as never[]));
    return { results: rows as T[] };
  }
}

class FakeD1 {
  constructor(private readonly db: DatabaseSyncType) {}
  prepare(sql: string): FakeStmt {
    return new FakeStmt(this.db.prepare(sql));
  }
  async batch(stmts: FakeStmt[]): Promise<{ meta: { changes: number } }[]> {
    const out: { meta: { changes: number } }[] = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

/**
 * Create an in-memory DB with the real migrations applied, in order, typed as a D1Database.
 *
 * `upTo` stops after the named migration, so a test can build a database that looks like a
 * deployment which has not been migrated yet — that is the only way to test what happens when new
 * code meets an older schema, which is the failure mode a deploy actually risks.
 */
export function makeTestDb(upTo?: string): D1Database {
  return makeTestDbWithHandle(upTo).db;
}

/** As makeTestDb, but also returns the raw handle so a test can apply a migration mid-flight. */
export function makeTestDbWithHandle(upTo?: string): { db: D1Database; raw: DatabaseSyncType } {
  const raw = new DatabaseSync(":memory:");
  for (const f of migrationFiles()) {
    raw.exec(readFileSync(new URL(f, schemaDir()), "utf8"));
    if (upTo && f.startsWith(upTo)) break;
  }
  return { db: new FakeD1(raw) as unknown as D1Database, raw };
}

/** Apply one migration by filename to an existing handle (simulates `d1 migrations apply`). */
export function applyMigration(raw: DatabaseSyncType, file: string): void {
  raw.exec(readFileSync(new URL(file, schemaDir()), "utf8"));
}

export function migrationFiles(): string[] {
  return readdirSync(schemaDir()).filter((f) => f.endsWith(".sql")).sort();
}

function schemaDir(): URL {
  return new URL("../../schema/", import.meta.url);
}
