import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return db;
}
