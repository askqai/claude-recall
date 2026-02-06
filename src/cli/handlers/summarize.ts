/**
 * Summarize Handler - Stop
 *
 * Reads the conversation transcript (JSONL) from transcript_path,
 * extracts Claude's assistant text responses, and stores them in
 * raw_observations so the next session has the full picture.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { openDatabase } from '../../services/sqlite/DirectDB.js';
import { getProjectName } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { readFileSync } from 'fs';

/** Max chars per assistant response to store */
const MAX_RESPONSE_CHARS = 10_000;

interface TranscriptMessage {
  type?: string;
  role?: string;
  content?: unknown;
  message?: { role?: string; content?: unknown };
}

/**
 * Extract text content from a transcript message's content field.
 * Content can be a string or an array of content blocks.
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text)
      .join('\n');
  }
  return '';
}

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, transcriptPath } = input;

    if (!transcriptPath || !sessionId) {
      return { continue: true, suppressOutput: true };
    }

    let transcriptData: string;
    try {
      transcriptData = readFileSync(transcriptPath, 'utf-8');
    } catch (err) {
      logger.debug('HOOK', `Could not read transcript: ${err}`);
      return { continue: true, suppressOutput: true };
    }

    const project = getProjectName(cwd);
    const now = new Date();
    const nowEpoch = Math.floor(now.getTime() / 1000);

    // Parse JSONL — each line is a JSON object
    const lines = transcriptData.split('\n').filter(l => l.trim());
    const assistantResponses: string[] = [];
    let promptNumber = 0;

    for (const line of lines) {
      try {
        const msg: TranscriptMessage = JSON.parse(line);

        // Track prompt numbers for correlation
        const role = msg.role ?? msg.message?.role;
        if (role === 'user') {
          promptNumber++;
        }

        // Collect assistant text responses
        if (role === 'assistant') {
          const content = msg.content ?? msg.message?.content;
          const text = extractText(content);
          if (text.trim()) {
            assistantResponses.push(JSON.stringify({
              prompt_number: promptNumber,
              text: text.length > MAX_RESPONSE_CHARS
                ? text.slice(0, MAX_RESPONSE_CHARS) + '...[truncated]'
                : text
            }));
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (assistantResponses.length === 0) {
      return { continue: true, suppressOutput: true };
    }

    // Store assistant responses as a single observation
    const db = openDatabase();
    try {
      db.run(
        `INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status)
         VALUES (?, ?, ?, ?, 'active')`,
        [sessionId, project, now.toISOString(), nowEpoch]
      );

      // Store as a special _assistant_responses observation (replace previous snapshot)
      const responsesJson = JSON.stringify(assistantResponses.map(r => JSON.parse(r)));
      const capped = responsesJson.length > 50_000
        ? responsesJson.slice(0, 50_000) + '...[truncated]'
        : responsesJson;

      db.run(
        `DELETE FROM raw_observations WHERE content_session_id = ? AND tool_name = '_assistant_responses'`,
        [sessionId]
      );
      db.run(
        `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch)
         VALUES (?, ?, '_assistant_responses', NULL, ?, ?, ?, ?, ?)`,
        [sessionId, project, capped, cwd, promptNumber, now.toISOString(), nowEpoch]
      );

      logger.debug('HOOK', `Stored ${assistantResponses.length} assistant responses from transcript`);
    } finally {
      db.close();
    }

    return { continue: true, suppressOutput: true };
  }
};
