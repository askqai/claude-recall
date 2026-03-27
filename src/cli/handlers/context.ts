/**
 * Context Handler - SessionStart
 *
 * Injects a COMPACT summary (~2K tokens) of the most recent session for this
 * project. Full details are available on demand via MCP tools (search, timeline,
 * get_observations). This keeps token usage low while still orienting Claude.
 *
 * The repo directory is the anchor — works after crashes, reboots, or new sessions.
 *
 * Queries SQLite directly. No worker daemon.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { openDatabase } from '../../services/sqlite/DirectDB.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';

/** Compact summary budget: ~2000 tokens */
const MAX_SUMMARY_CHARS = 8000;

interface RawObsRow {
  id: number;
  content_session_id: string;
  tool_name: string;
  tool_input: string | null;
  tool_response: string | null;
  prompt_number: number | null;
}

interface PromptRow {
  prompt_number: number;
  prompt_text: string;
}

interface SessionRow {
  content_session_id: string;
  project: string;
  status: string;
  prompt_counter: number;
  started_at: string;
  started_at_epoch: number;
}

/**
 * Build a compact summary of the most recent session.
 * Shows: prompts (truncated), unique files touched, commands run, Claude's key responses.
 * Full detail available via MCP tools.
 */
function buildCompactSummary(db: any, session: SessionRow): string {
  const sid = session.content_session_id;

  // Get prompts
  const prompts = db.prepare(
    `SELECT prompt_number, prompt_text FROM user_prompts
     WHERE content_session_id = ? ORDER BY prompt_number ASC`
  ).all(sid) as PromptRow[];

  // Get observations (exclude _assistant_responses for the summary)
  const observations = db.prepare(
    `SELECT id, content_session_id, tool_name, tool_input, tool_response, prompt_number
     FROM raw_observations
     WHERE content_session_id = ? AND tool_name != '_assistant_responses'
     ORDER BY id ASC`
  ).all(sid) as RawObsRow[];

  // Get assistant responses
  const assistantRow = db.prepare(
    `SELECT tool_response FROM raw_observations
     WHERE content_session_id = ? AND tool_name = '_assistant_responses'
     ORDER BY id DESC LIMIT 1`
  ).get(sid) as { tool_response: string } | undefined;

  let assistantResponses: Array<{ prompt_number: number; text: string }> = [];
  if (assistantRow?.tool_response) {
    try { assistantResponses = JSON.parse(assistantRow.tool_response); } catch {}
  }
  const assistantByPrompt = new Map<number, string>();
  for (const r of assistantResponses) {
    assistantByPrompt.set(r.prompt_number, r.text);
  }

  // Extract unique files touched
  const filesTouched = new Set<string>();
  const commandsRun: string[] = [];
  for (const o of observations) {
    let input: any = o.tool_input;
    try { input = JSON.parse(input ?? ''); } catch {}

    if (['Read', 'Write', 'Edit'].includes(o.tool_name) && input?.file_path) {
      filesTouched.add(input.file_path);
    }
    if (o.tool_name === 'Bash' && input?.command) {
      const cmd = typeof input.command === 'string' ? input.command : JSON.stringify(input.command);
      commandsRun.push(cmd.slice(0, 120));
    }
  }

  const statusLabel = session.status === 'active' ? 'interrupted' : 'completed';
  const lines: string[] = [];
  lines.push(`# Previous Session — ${session.project}`);
  lines.push(`Status: ${statusLabel} | Started: ${session.started_at} | ${session.prompt_counter} prompts, ${observations.length} tool uses`);
  lines.push(`Use MCP tools (search, timeline, get_observations) for full details.\n`);

  let used = lines.join('\n').length;

  // Show each prompt with truncated text + Claude's response snippet
  for (const p of prompts) {
    if (used > MAX_SUMMARY_CHARS - 200) break;

    const promptSnippet = p.prompt_text.length > 300
      ? p.prompt_text.slice(0, 300) + '...'
      : p.prompt_text;
    const pLine = `## Prompt ${p.prompt_number}\n> ${promptSnippet.replace(/\n/g, ' ')}\n`;
    lines.push(pLine);
    used += pLine.length;

    // Add Claude's response snippet if available
    const resp = assistantByPrompt.get(p.prompt_number);
    if (resp && used < MAX_SUMMARY_CHARS - 200) {
      const respSnippet = resp.length > 400 ? resp.slice(0, 400) + '...' : resp;
      const rLine = `**Claude:** ${respSnippet.replace(/\n/g, ' ')}\n`;
      lines.push(rLine);
      used += rLine.length;
    }
  }

  // Show files touched
  if (filesTouched.size > 0 && used < MAX_SUMMARY_CHARS - 200) {
    const fileList = [...filesTouched].slice(0, 15);
    lines.push(`\n### Files touched (${filesTouched.size}):`);
    for (const f of fileList) {
      const fLine = `- ${f}\n`;
      lines.push(fLine);
      used += fLine.length;
      if (used > MAX_SUMMARY_CHARS - 100) break;
    }
    if (filesTouched.size > 15) lines.push(`- ...and ${filesTouched.size - 15} more\n`);
  }

  // Show key commands
  if (commandsRun.length > 0 && used < MAX_SUMMARY_CHARS - 200) {
    const cmds = commandsRun.slice(0, 8);
    lines.push(`\n### Commands run (${commandsRun.length}):`);
    for (const c of cmds) {
      const cLine = `- \`${c}\`\n`;
      lines.push(cLine);
      used += cLine.length;
      if (used > MAX_SUMMARY_CHARS - 100) break;
    }
  }

  return lines.join('\n').trim();
}

/**
 * Get brief summaries of recent activity in OTHER projects.
 * Helps surface cross-project patterns and recent work context.
 */
function buildCrossProjectSummary(db: any, currentProjects: string[]): string {
  const placeholders = currentProjects.map(() => '?').join(',');
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;

  let rows: Array<{ project: string; last_active: number; session_count: number }>;
  try {
    rows = db.prepare(
      `SELECT project, MAX(started_at_epoch) as last_active, COUNT(*) as session_count
       FROM sdk_sessions
       WHERE project NOT IN (${placeholders}) AND started_at_epoch > ?
       GROUP BY project
       ORDER BY last_active DESC
       LIMIT 5`
    ).all(...currentProjects, sevenDaysAgo);
  } catch {
    return '';
  }

  if (!rows || rows.length === 0) return '';

  const lines = ['## Recent Activity in Other Projects'];
  let used = lines[0].length;

  for (const r of rows) {
    if (used > MAX_CROSS_PROJECT_CHARS - 100) break;

    // Get most recent prompt from that project
    let snippet = '';
    try {
      const recentPrompt = db.prepare(
        `SELECT up.prompt_text FROM user_prompts up
         JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
         WHERE s.project = ?
         ORDER BY up.created_at_epoch DESC LIMIT 1`
      ).get(r.project) as { prompt_text: string } | undefined;
      snippet = recentPrompt?.prompt_text?.slice(0, 80)?.replace(/\n/g, ' ') || '';
    } catch {}

    const line = `- **${r.project}** (${r.session_count} sessions): ${snippet}`;
    lines.push(line);
    used += line.length;
  }

  return lines.join('\n');
}

/**
 * Get brief context from consolidated (older) sessions for this project.
 * Returns a short section showing what was worked on historically.
 */
function getConsolidatedContext(db: any, projects: string[], currentLength: number): string {
  const budget = MAX_SUMMARY_CHARS - currentLength - 200;
  if (budget < 200) return '';

  const placeholders = projects.map(() => '?').join(',');
  let rows: Array<{ project: string; summary: string; prompt_count: number; tool_use_count: number; original_started_at: string }>;
  try {
    rows = db.prepare(
      `SELECT project, summary, prompt_count, tool_use_count, original_started_at
       FROM consolidated_sessions
       WHERE project IN (${placeholders})
       ORDER BY original_started_at_epoch DESC
       LIMIT 5`
    ).all(...projects);
  } catch {
    return ''; // table may not exist yet
  }

  if (!rows || rows.length === 0) return '';

  const lines = ['## Older Sessions (consolidated)'];
  let used = lines[0].length;

  for (const r of rows) {
    if (used > budget) break;
    const snippet = r.summary.length > 150 ? r.summary.slice(0, 150) + '...' : r.summary;
    const line = `- **${r.original_started_at.split('T')[0]}** (${r.prompt_count}p/${r.tool_use_count}t): ${snippet.replace(/\n/g, ' ')}`;
    lines.push(line);
    used += line.length;
  }

  return lines.join('\n');
}

// ─── Main handler ───────────────────────────────────────────────────────

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const cwd = input.cwd ?? process.cwd();
    const context = getProjectContext(cwd);
    const db = openDatabase();

    try {
      const projects = context.allProjects;
      const placeholders = projects.map(() => '?').join(',');

      const sessions = db.prepare(
        `SELECT content_session_id, project, status, prompt_counter, started_at, started_at_epoch
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

      // Pick the most substantial recent session (most prompts among the last 5).
      // A 1-prompt "what was I doing?" session is less useful than a 10-prompt coding session.
      const withPrompts = sessions.filter(s => s.prompt_counter > 0);
      const bestSession = withPrompts.length > 0
        ? withPrompts.reduce((a, b) => a.prompt_counter >= b.prompt_counter ? a : b)
        : sessions[0];
      let additionalContext = bestSession.prompt_counter > 0
        ? buildCompactSummary(db, bestSession)
        : '';

      // Append consolidated session summaries if budget allows
      if (additionalContext.length < MAX_SUMMARY_CHARS - 500) {
        const consolidated = getConsolidatedContext(db, projects, additionalContext.length);
        if (consolidated) {
          additionalContext += '\n\n' + consolidated;
        }
      }

      // Cross-project recall is available on-demand via MCP search(cross_project=true)
      // Not injected automatically to keep context focused on the current project.

      logger.debug('HOOK', 'Context generated', {
        sessions: sessions.length,
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
