/**
 * Observation Handler - PostToolUse
 *
 * Stores raw tool data directly to SQLite. No worker daemon, no subprocess.
 * Caps tool_response at 10KB to prevent DB bloat.
 * Runs periodic cleanup of old observations (>30 days).
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { openDatabase } from '../../services/sqlite/DirectDB.js';
import { getProjectName } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';

/** Max size for tool_response storage (10KB). Larger responses are truncated. */
const MAX_RESPONSE_BYTES = 10_000;
/** Max size for tool_input storage (10KB). */
const MAX_INPUT_BYTES = 10_000;
/** Max database page count before cleanup triggers.
 * SQLite page_size is 4096 bytes by default.
 * 10GB = 10 * 1024 * 1024 * 1024 / 4096 = 2,621,440 pages */
const MAX_DB_PAGES = 2_621_440;
/** Only check DB size ~1% of the time to avoid overhead */
const CLEANUP_PROBABILITY = 0.01;
/** Delete oldest 10% of raw_observations when over size limit */
const CLEANUP_BATCH_PERCENT = 0.10;

function truncateStr(s: string | null, maxLen: number): string | null {
  if (s == null) return null;
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...[truncated at ' + maxLen + ' chars]';
}

function stringify(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, toolName, toolInput, toolResponse } = input;

    if (!toolName) {
      throw new Error('observationHandler requires toolName');
    }
    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }

    const project = getProjectName(cwd);
    const now = new Date();
    const nowEpoch = Math.floor(now.getTime() / 1000);
    const db = openDatabase();

    try {
      // Ensure session exists
      db.run(
        `INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status)
         VALUES (?, ?, ?, ?, 'active')`,
        [sessionId, project, now.toISOString(), nowEpoch]
      );

      // Get current prompt number for this session
      const session = db.prepare(
        'SELECT prompt_counter FROM sdk_sessions WHERE content_session_id = ?'
      ).get(sessionId) as { prompt_counter: number } | undefined;
      const promptNumber = session?.prompt_counter ?? 0;

      // Truncate large payloads to prevent DB bloat
      const inputStr = truncateStr(stringify(toolInput), MAX_INPUT_BYTES);
      const responseStr = truncateStr(stringify(toolResponse), MAX_RESPONSE_BYTES);

      db.run(
        `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, project, toolName, inputStr, responseStr, cwd, promptNumber, now.toISOString(), nowEpoch]
      );

      // Periodic size-based cleanup: delete oldest observations when DB exceeds 10GB
      // Only checks ~1% of the time to avoid PRAGMA overhead on every write
      if (Math.random() < CLEANUP_PROBABILITY) {
        const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number })?.page_count ?? 0;
        if (pageCount > MAX_DB_PAGES) {
          // Delete oldest 10% of raw_observations to reclaim space
          const totalRows = (db.prepare('SELECT COUNT(*) as cnt FROM raw_observations').get() as { cnt: number })?.cnt ?? 0;
          const deleteCount = Math.max(100, Math.floor(totalRows * CLEANUP_BATCH_PERCENT));
          const deleted = db.run(
            `DELETE FROM raw_observations WHERE id IN (
              SELECT id FROM raw_observations ORDER BY created_at_epoch ASC LIMIT ?
            )`,
            [deleteCount]
          );
          if (deleted.changes > 0) {
            logger.info('HOOK', `Size cleanup: deleted ${deleted.changes} oldest observations (DB was ${Math.round(pageCount * 4096 / 1024 / 1024)}MB, limit 10GB)`);
          }
        }
      }

      logger.debug('HOOK', 'Raw observation stored', { toolName });
    } finally {
      db.close();
    }

    return { continue: true, suppressOutput: true };
  }
};
