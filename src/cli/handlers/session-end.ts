/**
 * Session End Handler - SessionEnd
 *
 * Marks session as completed directly in SQLite.
 * No worker daemon needed.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { openDatabase } from '../../services/sqlite/DirectDB.js';
import { logger } from '../../utils/logger.js';

export const sessionEndHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId } = input;
    const now = new Date();
    const db = openDatabase();

    try {
      db.run(
        `UPDATE sdk_sessions SET status = 'completed', completed_at = ?, completed_at_epoch = ?
         WHERE content_session_id = ? AND status = 'active'`,
        [now.toISOString(), Math.floor(now.getTime() / 1000), sessionId]
      );

      logger.debug('HOOK', 'SessionEnd: Session marked completed', { contentSessionId: sessionId });
    } catch (error) {
      logger.warn('HOOK', 'SessionEnd: Failed to mark session completed', {
        contentSessionId: sessionId
      });
    } finally {
      db.close();
    }

    return { continue: true, suppressOutput: true };
  }
};
