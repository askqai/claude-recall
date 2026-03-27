/**
 * Session Init Handler - UserPromptSubmit
 *
 * Creates/updates session and stores user prompt directly in SQLite.
 * Uses a transaction for atomic prompt counter increment.
 * No worker daemon, no SDK agent, no RAG query.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { openDatabase } from '../../services/sqlite/DirectDB.js';
import { getProjectName } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { isPrivatePrompt } from '../../utils/privacy.js';

export const sessionInitHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, prompt } = input;

    if (!prompt) {
      throw new Error('sessionInitHandler requires prompt');
    }

    const project = getProjectName(cwd);
    const now = new Date();
    const nowIso = now.toISOString();
    const nowEpoch = Math.floor(now.getTime() / 1000);
    const db = openDatabase();

    try {
      const isPrivate = isPrivatePrompt(prompt);

      // Atomic transaction: create session + increment counter + store prompt
      const initSession = db.transaction(() => {
        // Create session if it doesn't exist
        db.run(
          `INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status, prompt_counter)
           VALUES (?, ?, ?, ?, 'active', 0)`,
          [sessionId, project, nowIso, nowEpoch]
        );

        // Set or clear privacy suppression flag
        db.run(
          'UPDATE sdk_sessions SET prompt_counter = prompt_counter + 1, privacy_suppressed = ? WHERE content_session_id = ?',
          [isPrivate ? 1 : 0, sessionId]
        );
        const session = db.prepare(
          'SELECT id, prompt_counter FROM sdk_sessions WHERE content_session_id = ?'
        ).get(sessionId) as { id: number; prompt_counter: number };

        const promptNumber = session.prompt_counter;

        // Store the user prompt (redacted if private)
        const promptText = isPrivate ? '[PRIVATE - prompt not stored]' : prompt;
        db.run(
          `INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
           VALUES (?, ?, ?, ?, ?)`,
          [sessionId, promptNumber, promptText, nowIso, nowEpoch]
        );

        return { sessionDbId: session.id, promptNumber };
      });

      const result = initSession();

      logger.debug('HOOK', `session-init: prompt #${result.promptNumber} stored`, {
        sessionId: result.sessionDbId
      });
    } finally {
      db.close();
    }

    return { continue: true, suppressOutput: true };
  }
};
