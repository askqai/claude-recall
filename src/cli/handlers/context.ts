/**
 * Context Handler - SessionStart
 *
 * Two modes:
 *
 * 1. RECOVERY MODE (default when there's recent activity in the project)
 *    Dumps the last 24 hours of activity in full fidelity — prompts, assistant
 *    responses, tool uses — up to a token budget. Designed for "I crashed,
 *    restarted, get me back to where I was" without needing to search.
 *
 * 2. SUMMARY MODE (fallback when no recent activity)
 *    Compact ~2K token summary of the most substantial recent session.
 *    For when you're returning to a project after days/weeks away.
 *
 * Configurable via env vars:
 *   CLAUDE_RECALL_RECOVERY_WINDOW_HOURS   (default: 24)
 *   CLAUDE_RECALL_RECOVERY_BUDGET_TOKENS  (default: 200000, max practical: 1000000)
 *
 * The repo directory is the anchor — works after crashes, reboots, or new sessions.
 * Queries SQLite directly. No worker daemon.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { openDatabase } from '../../services/sqlite/DirectDB.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';

/** Compact summary budget (fallback mode): ~2000 tokens */
const MAX_SUMMARY_CHARS = 8000;

/** Recovery window in hours — how recent must activity be to trigger recovery mode */
const RECOVERY_WINDOW_HOURS = Number(process.env.CLAUDE_RECALL_RECOVERY_WINDOW_HOURS) || 24;

/** Recovery budget in tokens — uses ~4 chars/token approximation */
const RECOVERY_BUDGET_TOKENS = Number(process.env.CLAUDE_RECALL_RECOVERY_BUDGET_TOKENS) || 200_000;
const CHARS_PER_TOKEN = 4;
const RECOVERY_BUDGET_CHARS = RECOVERY_BUDGET_TOKENS * CHARS_PER_TOKEN;

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

interface SessionWithActivity extends SessionRow {
  last_activity_epoch: number | null;
}

/**
 * Format "X minutes ago" / "X hours ago" / "X days ago".
 */
function formatTimeAgo(epoch: number, now: number): string {
  const seconds = now - epoch;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.floor(seconds / 86400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/**
 * Format a tool use for the recovery dump — compact but informative.
 */
function formatToolUse(o: RawObsRow): string {
  let input: any = o.tool_input;
  try { input = JSON.parse(input ?? ''); } catch {}

  if (['Read', 'Write', 'Edit'].includes(o.tool_name) && input?.file_path) {
    return `- **${o.tool_name}** ${input.file_path}`;
  }
  if (o.tool_name === 'Bash' && input?.command) {
    const cmd = typeof input.command === 'string' ? input.command : JSON.stringify(input.command);
    return `- **Bash**: \`${cmd.slice(0, 200)}${cmd.length > 200 ? '...' : ''}\``;
  }
  if ((o.tool_name === 'Grep' || o.tool_name === 'Glob') && input?.pattern) {
    return `- **${o.tool_name}** "${input.pattern}"${input.path ? ` in ${input.path}` : ''}`;
  }
  if (o.tool_name === 'WebFetch' && input?.url) {
    return `- **WebFetch** ${input.url}`;
  }
  if (o.tool_name === 'WebSearch' && input?.query) {
    return `- **WebSearch** "${input.query}"`;
  }
  return `- **${o.tool_name}**`;
}

/**
 * Build a full-fidelity recovery dump of the most recent session(s).
 * Returns null if no sessions are within the recovery window.
 */
function buildRecoveryContext(db: any, projects: string[]): string | null {
  const placeholders = projects.map(() => '?').join(',');
  const cutoffEpoch = Math.floor(Date.now() / 1000) - RECOVERY_WINDOW_HOURS * 3600;

  // Find sessions with activity (prompts or observations) in the recovery window
  const sessions = db.prepare(
    `SELECT s.content_session_id, s.project, s.status, s.prompt_counter,
            s.started_at, s.started_at_epoch,
            (SELECT MAX(created_at_epoch) FROM raw_observations
             WHERE content_session_id = s.content_session_id) as last_activity_epoch
     FROM sdk_sessions s
     WHERE s.project IN (${placeholders})
       AND s.prompt_counter > 0
       AND COALESCE(
         (SELECT MAX(created_at_epoch) FROM raw_observations
          WHERE content_session_id = s.content_session_id),
         s.started_at_epoch
       ) > ?
     ORDER BY COALESCE(
       (SELECT MAX(created_at_epoch) FROM raw_observations
        WHERE content_session_id = s.content_session_id),
       s.started_at_epoch
     ) DESC`
  ).all(...projects, cutoffEpoch) as SessionWithActivity[];

  if (sessions.length === 0) return null;

  const now = Math.floor(Date.now() / 1000);
  const lines: string[] = [];

  // Header
  const mostRecent = sessions[0];
  const lastEpoch = mostRecent.last_activity_epoch ?? mostRecent.started_at_epoch;
  const timeAgo = formatTimeAgo(lastEpoch, now);

  lines.push(`# Session Recovery — ${mostRecent.project}`);
  lines.push(`Last activity: ${timeAgo}. Recovered ${sessions.length} session(s) from the last ${RECOVERY_WINDOW_HOURS} hours.`);
  lines.push(`This is a full-fidelity dump of recent work — pick up where you left off.`);
  lines.push(`For older history, use MCP tools (search, timeline, get_observations).\n`);

  let used = lines.join('\n').length;

  // Dump each session newest-first until budget is exhausted
  for (const session of sessions) {
    if (used > RECOVERY_BUDGET_CHARS - 1000) {
      lines.push(`\n---\n*${sessions.length - sessions.indexOf(session)} more session(s) within window — budget exhausted. Use MCP search for older detail.*`);
      break;
    }

    const dump = buildSessionDump(db, session, RECOVERY_BUDGET_CHARS - used);
    if (dump) {
      lines.push(dump);
      used += dump.length;
    }
  }

  return lines.join('\n').trim();
}

/**
 * Build a full dump for a single session, respecting the given budget.
 */
function buildSessionDump(db: any, session: SessionWithActivity, budget: number): string {
  const sid = session.content_session_id;

  const prompts = db.prepare(
    `SELECT prompt_number, prompt_text FROM user_prompts
     WHERE content_session_id = ? ORDER BY prompt_number ASC`
  ).all(sid) as PromptRow[];

  const observations = db.prepare(
    `SELECT id, content_session_id, tool_name, tool_input, tool_response, prompt_number
     FROM raw_observations
     WHERE content_session_id = ? AND tool_name != '_assistant_responses'
     ORDER BY id ASC`
  ).all(sid) as RawObsRow[];

  // Get assistant responses snapshot
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

  // Group observations by prompt_number
  const observationsByPrompt = new Map<number, RawObsRow[]>();
  for (const obs of observations) {
    const p = obs.prompt_number ?? 0;
    if (!observationsByPrompt.has(p)) observationsByPrompt.set(p, []);
    observationsByPrompt.get(p)!.push(obs);
  }

  // Build dump
  const lines: string[] = [];
  const statusLabel = session.status === 'active' ? 'interrupted' : session.status;
  const sessionDate = new Date(session.started_at_epoch * 1000).toISOString().replace('T', ' ').slice(0, 19);

  lines.push(`\n---\n## Session ${sessionDate} UTC (${statusLabel}) — ${session.prompt_counter} prompt(s), ${observations.length} tool use(s)\n`);
  let used = lines.join('\n').length;

  for (const p of prompts) {
    if (used > budget - 500) break;

    // Full prompt text
    const promptBlock = `### Prompt ${p.prompt_number}\n> ${p.prompt_text.replace(/\n/g, '\n> ')}\n`;
    if (used + promptBlock.length > budget - 200) break;
    lines.push(promptBlock);
    used += promptBlock.length;

    // Full assistant response (truncate gracefully if it would overshoot)
    const resp = assistantByPrompt.get(p.prompt_number);
    if (resp) {
      const respBlock = `\n**Claude:** ${resp}\n`;
      if (used + respBlock.length > budget - 200) {
        const remaining = budget - used - 300;
        if (remaining > 200) {
          lines.push(respBlock.slice(0, remaining) + '\n...[truncated for budget]\n');
          used += remaining + 30;
        }
        break;
      }
      lines.push(respBlock);
      used += respBlock.length;
    }

    // Tool uses for this prompt — compact one-liners
    const obs = observationsByPrompt.get(p.prompt_number) ?? [];
    if (obs.length > 0) {
      const toolLines = ['\n#### Tool uses', ...obs.map(formatToolUse)];
      const toolBlock = toolLines.join('\n') + '\n';
      if (used + toolBlock.length < budget - 100) {
        lines.push(toolBlock);
        used += toolBlock.length;
      }
    }
  }

  return lines.join('\n');
}

/**
 * Build a compact summary of the most recent session.
 * Shows: prompts (truncated), unique files touched, commands run, Claude's key responses.
 * Used as fallback when there's no recent activity within the recovery window.
 */
function buildCompactSummary(db: any, session: SessionRow): string {
  const sid = session.content_session_id;

  const prompts = db.prepare(
    `SELECT prompt_number, prompt_text FROM user_prompts
     WHERE content_session_id = ? ORDER BY prompt_number ASC`
  ).all(sid) as PromptRow[];

  const observations = db.prepare(
    `SELECT id, content_session_id, tool_name, tool_input, tool_response, prompt_number
     FROM raw_observations
     WHERE content_session_id = ? AND tool_name != '_assistant_responses'
     ORDER BY id ASC`
  ).all(sid) as RawObsRow[];

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

  for (const p of prompts) {
    if (used > MAX_SUMMARY_CHARS - 200) break;

    const promptSnippet = p.prompt_text.length > 300
      ? p.prompt_text.slice(0, 300) + '...'
      : p.prompt_text;
    const pLine = `## Prompt ${p.prompt_number}\n> ${promptSnippet.replace(/\n/g, ' ')}\n`;
    lines.push(pLine);
    used += pLine.length;

    const resp = assistantByPrompt.get(p.prompt_number);
    if (resp && used < MAX_SUMMARY_CHARS - 200) {
      const respSnippet = resp.length > 400 ? resp.slice(0, 400) + '...' : resp;
      const rLine = `**Claude:** ${respSnippet.replace(/\n/g, ' ')}\n`;
      lines.push(rLine);
      used += rLine.length;
    }
  }

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
    return '';
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

      // ─── RECOVERY MODE ───
      // If there's recent activity within the window, dump it in full fidelity.
      const recoveryContext = buildRecoveryContext(db, projects);
      if (recoveryContext) {
        logger.debug('HOOK', 'Recovery mode active', {
          contextLength: recoveryContext.length,
          windowHours: RECOVERY_WINDOW_HOURS,
          budgetTokens: RECOVERY_BUDGET_TOKENS
        });
        return {
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: recoveryContext
          }
        };
      }

      // ─── SUMMARY MODE (fallback) ───
      // No recent activity — provide compact summary of best historical session.
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

      // Pick most substantial recent session
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

      logger.debug('HOOK', 'Summary mode (no recent activity)', {
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
