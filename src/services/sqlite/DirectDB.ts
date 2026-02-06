/**
 * DirectDB - Thin wrapper for direct SQLite access from hooks and MCP server.
 *
 * Replaces the HTTP worker proxy with direct bun:sqlite connections.
 * Sets WAL mode, busy_timeout, foreign_keys, synchronous=NORMAL.
 * Runs MigrationRunner to ensure schema is up to date.
 */

import { Database } from 'bun:sqlite';
import { DB_PATH, DATA_DIR, ensureDir } from '../../shared/paths.js';
import { MigrationRunner } from './migrations/runner.js';

/**
 * Open a database connection with optimized settings and run migrations.
 * Caller is responsible for closing the returned Database when done.
 */
export function openDatabase(dbPath: string = DB_PATH): Database {
  if (dbPath !== ':memory:') {
    ensureDir(DATA_DIR);
  }

  const db = new Database(dbPath, { create: true, readwrite: true });

  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA synchronous = NORMAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA temp_store = memory');

  const migrationRunner = new MigrationRunner(db);
  migrationRunner.runAllMigrations();

  return db;
}
