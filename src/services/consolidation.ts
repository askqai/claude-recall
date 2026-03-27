/**
 * Consolidation Module
 *
 * Handles three aspects of memory lifecycle:
 * 1. consolidateOldSessions — keep last 20 sessions per project, compress the rest
 * 2. applyTimeDecay — reduce relevance scores of observations older than 90 days
 * 3. smartCleanup — delete low-relevance observations first when DB is too large
 *
 * All functions are designed to be called from the observation handler's
 * periodic cleanup check (1% probability per tool use).
 */

import type { Database } from 'bun:sqlite';
import { logger } from '../utils/logger.js';

/** Keep this many recent sessions per project before consolidating older ones */
const SESSIONS_TO_KEEP_PER_PROJECT = 20;
/** Max sessions to consolidate per invocation (keeps hook fast) */
const MAX_CONSOLIDATION_BATCH = 5;
/** Observations older than this get time-decayed */
const DECAY_AGE_SECONDS = 90 * 24 * 3600; // 90 days
/** Decay multiplier applied to relevance_score */
const DECAY_FACTOR = 0.5;
/** Floor for decayed scores — prevents infinite decay to 0 */
const DECAY_FLOOR = 0.05;

interface ObsRow {
  tool_name: string;
  tool_input: string | null;
}

interface PromptRow {
  prompt_number: number;
  prompt_text: string;
}

/**
 * Consolidate older sessions beyond the per-project retention limit.
 * Keeps the most recent N sessions per project with full detail.
 * Older sessions are compressed into summaries, raw data deleted.
 *
 * This is count-based, not time-based — if you pause a project for weeks,
 * your sessions stay intact until you create enough new ones to push them out.
 */
export function consolidateOldSessions(db: Database): void {
  // Find projects that have more completed sessions than the retention limit
  const overflowProjects = db.prepare(`
    SELECT project, COUNT(*) as session_count
    FROM sdk_sessions
    WHERE status = 'completed'
      AND content_session_id NOT IN (SELECT content_session_id FROM consolidated_sessions)
      AND EXISTS (SELECT 1 FROM raw_observations WHERE content_session_id = sdk_sessions.content_session_id)
    GROUP BY project
    HAVING COUNT(*) > ?
  `).all(SESSIONS_TO_KEEP_PER_PROJECT) as Array<{ project: string; session_count: number }>;

  if (overflowProjects.length === 0) return;

  // For each project, find sessions beyond the retention limit (oldest first)
  const sessions: Array<{ content_session_id: string; project: string; started_at: string; started_at_epoch: number; prompt_counter: number }> = [];

  for (const { project } of overflowProjects) {
    const oldest = db.prepare(`
      SELECT s.content_session_id, s.project, s.started_at, s.started_at_epoch, s.prompt_counter
      FROM sdk_sessions s
      WHERE s.status = 'completed'
        AND s.project = ?
        AND s.content_session_id NOT IN (SELECT content_session_id FROM consolidated_sessions)
        AND EXISTS (SELECT 1 FROM raw_observations WHERE content_session_id = s.content_session_id)
      ORDER BY s.started_at_epoch DESC
      LIMIT -1 OFFSET ?
    `).all(project, SESSIONS_TO_KEEP_PER_PROJECT) as typeof sessions;

    sessions.push(...oldest);
    if (sessions.length >= MAX_CONSOLIDATION_BATCH) break;
  }

  // Cap to batch size
  const batch = sessions.slice(0, MAX_CONSOLIDATION_BATCH);

  if (batch.length === 0) return;

  const now = new Date();
  const nowIso = now.toISOString();
  const nowEpoch = Math.floor(now.getTime() / 1000);

  for (const session of batch) {
    try {
      const summary = buildSessionSummary(db, session.content_session_id);

      // Count tool uses
      const toolCount = (db.prepare(
        `SELECT COUNT(*) as cnt FROM raw_observations
         WHERE content_session_id = ? AND tool_name != '_assistant_responses'`
      ).get(session.content_session_id) as { cnt: number })?.cnt ?? 0;

      // Extract files and commands
      const observations = db.prepare(
        `SELECT tool_name, tool_input FROM raw_observations
         WHERE content_session_id = ? AND tool_name != '_assistant_responses'`
      ).all(session.content_session_id) as ObsRow[];

      const files = new Set<string>();
      const commands: string[] = [];
      for (const o of observations) {
        let input: any = o.tool_input;
        try { input = JSON.parse(input ?? ''); } catch {}
        if (['Read', 'Write', 'Edit'].includes(o.tool_name) && input?.file_path) {
          files.add(input.file_path);
        }
        if (o.tool_name === 'Bash' && input?.command) {
          commands.push(typeof input.command === 'string' ? input.command.slice(0, 100) : '');
        }
      }

      // Store consolidated summary
      db.run(
        `INSERT INTO consolidated_sessions
         (content_session_id, project, summary, prompt_count, tool_use_count,
          files_touched, commands_run, original_started_at, original_started_at_epoch,
          consolidated_at, consolidated_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          session.content_session_id, session.project, summary,
          session.prompt_counter, toolCount,
          JSON.stringify([...files].slice(0, 30)),
          JSON.stringify(commands.slice(0, 15)),
          session.started_at, session.started_at_epoch,
          nowIso, nowEpoch
        ]
      );

      // Delete raw data for this session (FTS triggers handle cleanup)
      db.run('DELETE FROM raw_observations WHERE content_session_id = ?', [session.content_session_id]);
      db.run('DELETE FROM user_prompts WHERE content_session_id = ?', [session.content_session_id]);

      logger.info('CONSOLIDATION', `Consolidated session ${session.content_session_id} (${session.project}): ${session.prompt_counter} prompts, ${toolCount} tools → summary`);
    } catch (err) {
      logger.error('CONSOLIDATION', `Failed to consolidate session ${session.content_session_id}`, undefined, err as Error);
    }
  }
}

/**
 * Build a compressed summary (~500 chars) for a session.
 */
function buildSessionSummary(db: Database, sessionId: string): string {
  const prompts = db.prepare(
    `SELECT prompt_number, prompt_text FROM user_prompts
     WHERE content_session_id = ? ORDER BY prompt_number ASC`
  ).all(sessionId) as PromptRow[];

  const lines: string[] = [];

  for (const p of prompts) {
    const snippet = p.prompt_text.length > 120
      ? p.prompt_text.slice(0, 120) + '...'
      : p.prompt_text;
    lines.push(`P${p.prompt_number}: ${snippet.replace(/\n/g, ' ')}`);
  }

  // Cap total summary at ~500 chars
  let summary = lines.join('\n');
  if (summary.length > 500) {
    summary = summary.slice(0, 497) + '...';
  }

  return summary || '(no prompts recorded)';
}

/**
 * Reduce relevance scores for observations older than 30 days.
 * Idempotent — scores converge toward DECAY_FLOOR over repeated applications.
 */
export function applyTimeDecay(db: Database): void {
  const cutoff = Math.floor(Date.now() / 1000) - DECAY_AGE_SECONDS;

  const result = db.run(
    `UPDATE raw_observations
     SET relevance_score = MAX(?, relevance_score * ?)
     WHERE created_at_epoch < ?
       AND relevance_score > ?`,
    [DECAY_FLOOR, DECAY_FACTOR, cutoff, DECAY_FLOOR]
  );

  if (result.changes > 0) {
    logger.debug('CONSOLIDATION', `Time decay applied to ${result.changes} observations`);
  }
}

/**
 * Delete low-relevance observations first when DB exceeds size limit.
 * Replaces the old "delete oldest 10%" approach.
 */
export function smartCleanup(db: Database, deleteCount: number): void {
  const result = db.run(
    `DELETE FROM raw_observations WHERE id IN (
      SELECT id FROM raw_observations
      ORDER BY relevance_score ASC, created_at_epoch ASC
      LIMIT ?
    )`,
    [deleteCount]
  );

  if (result.changes > 0) {
    logger.info('CONSOLIDATION', `Smart cleanup: deleted ${result.changes} low-relevance observations`);
  }
}
