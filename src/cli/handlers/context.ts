/**
 * Context Handler - SessionStart
 *
 * Queries recent raw_observations and user_prompts directly from SQLite,
 * formats as markdown, and returns as additionalContext for injection.
 * No worker daemon needed.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { openDatabase } from '../../services/sqlite/DirectDB.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';

/** Max characters for context injection (~4000 tokens) */
const MAX_CONTEXT_CHARS = 16000;

interface RawObsRow {
  id: number;
  content_session_id: string;
  tool_name: string;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}

interface PromptRow {
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
}

interface SessionRow {
  content_session_id: string;
  project: string;
  status: string;
  started_at: string;
}

/**
 * Format a single raw observation into a compact string
 */
function formatObservation(obs: RawObsRow): string {
  const tool = obs.tool_name;
  let input: any = obs.tool_input;
  try { input = JSON.parse(input ?? ''); } catch { /* keep as string */ }

  // Tool-specific compact formatters
  switch (tool) {
    case 'Write':
    case 'Read':
    case 'Edit':
      return `${tool}: ${input?.file_path ?? input ?? '(unknown)'}`;
    case 'Bash': {
      const cmd = input?.command ?? input ?? '';
      const cmdStr = typeof cmd === 'string' ? cmd : JSON.stringify(cmd);
      return `Bash: ${cmdStr.slice(0, 200)}`;
    }
    case 'Glob':
      return `Glob: ${input?.pattern ?? input ?? ''}`;
    case 'Grep':
      return `Grep: ${input?.pattern ?? input ?? ''}`;
    case 'Task':
      return `Task: ${input?.description ?? input?.subagent_type ?? '(agent)'}`;
    default: {
      const summary = typeof input === 'string' ? input.slice(0, 120) : JSON.stringify(input).slice(0, 120);
      return `${tool}: ${summary}`;
    }
  }
}

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const cwd = input.cwd ?? process.cwd();
    const context = getProjectContext(cwd);
    const db = openDatabase();

    try {
      // Build project filter for SQL
      const projects = context.allProjects;
      const placeholders = projects.map(() => '?').join(',');

      // Get recent sessions for these projects (last 5)
      const sessions = db.prepare(
        `SELECT content_session_id, project, status, started_at
         FROM sdk_sessions
         WHERE project IN (${placeholders})
         ORDER BY started_at_epoch DESC
         LIMIT 5`
      ).all(...projects) as SessionRow[];

      if (sessions.length === 0) {
        return {
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: ''
          }
        };
      }

      const sessionIds = sessions.map(s => s.content_session_id);
      const sessionPlaceholders = sessionIds.map(() => '?').join(',');

      // Get recent raw observations for these sessions (last 50)
      const observations = db.prepare(
        `SELECT id, content_session_id, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch
         FROM raw_observations
         WHERE content_session_id IN (${sessionPlaceholders})
         ORDER BY created_at_epoch DESC
         LIMIT 50`
      ).all(...sessionIds) as RawObsRow[];

      // Get recent user prompts for these sessions
      const prompts = db.prepare(
        `SELECT content_session_id, prompt_number, prompt_text, created_at
         FROM user_prompts
         WHERE content_session_id IN (${sessionPlaceholders})
         ORDER BY created_at_epoch DESC
         LIMIT 20`
      ).all(...sessionIds) as PromptRow[];

      // Group by session for display
      const sessionMap = new Map<string, { prompts: PromptRow[]; observations: RawObsRow[] }>();
      for (const s of sessions) {
        sessionMap.set(s.content_session_id, { prompts: [], observations: [] });
      }
      for (const p of prompts) {
        sessionMap.get(p.content_session_id)?.prompts.push(p);
      }
      for (const o of observations) {
        sessionMap.get(o.content_session_id)?.observations.push(o);
      }

      // Build markdown context - most recent session gets most space
      let lines: string[] = [];
      lines.push('# Recent Session Activity\n');

      let charBudget = MAX_CONTEXT_CHARS;
      const sessionBudgets = sessions.map((_, i) => i === 0 ? 0.6 : 0.4 / (sessions.length - 1 || 1));

      for (let i = 0; i < sessions.length && charBudget > 500; i++) {
        const s = sessions[i];
        const data = sessionMap.get(s.content_session_id);
        if (!data) continue;

        const budget = Math.floor(MAX_CONTEXT_CHARS * sessionBudgets[i]);
        let used = 0;

        const statusTag = s.status === 'completed' ? ' (completed)' : '';
        const header = `## Session: ${s.project}${statusTag} - ${s.started_at}\n`;
        lines.push(header);
        used += header.length;

        // Show prompts for this session
        for (const p of data.prompts.slice(0, 3)) {
          if (used > budget) break;
          const line = `- Prompt #${p.prompt_number}: ${p.prompt_text.slice(0, 200)}\n`;
          lines.push(line);
          used += line.length;
        }

        // Show observations for this session
        if (data.observations.length > 0) {
          lines.push('### Tool Activity:\n');
          used += 20;
          for (const obs of data.observations) {
            if (used > budget) break;
            const line = `- ${formatObservation(obs)}\n`;
            lines.push(line);
            used += line.length;
          }
        }

        lines.push('');
        charBudget -= used;
      }

      const additionalContext = lines.join('').trim();

      logger.debug('HOOK', 'Context generated', {
        sessions: sessions.length,
        observations: observations.length,
        prompts: prompts.length,
        contextLength: additionalContext.length
      });

      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext
        }
      };
    } finally {
      db.close();
    }
  }
};
