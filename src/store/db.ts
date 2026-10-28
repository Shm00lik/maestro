import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * Ordered schema migrations. Migration i (0-based) moves the db from user_version i to i + 1.
 * Never edit a shipped migration; append a new one instead.
 */
export const MIGRATIONS: readonly string[] = [
  readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'), // 1: baseline
];

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema version ${current} is newer than this build supports (${MIGRATIONS.length}).`);
  }
  if (current === MIGRATIONS.length) return;
  db.transaction(() => {
    for (let i = current; i < MIGRATIONS.length; i++) db.exec(MIGRATIONS[i]);
    db.pragma(`user_version = ${MIGRATIONS.length}`);
  })();
}

export function openDb(file: string): Db {
  const db = new Database(file);
  try {
    db.pragma('foreign_keys = ON');
    if (file !== ':memory:') db.pragma('journal_mode = WAL');
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
