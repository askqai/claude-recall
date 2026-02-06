/**
 * Context Handler - SessionStart
 *
 * When starting a new session, injects full context from the most recent session
 * for this project (identified by working directory). This works after crashes,
 * reboots, or simply opening a new session — the repo directory is the anchor.
 *
 * If the most recent session had prompts: full chronological reconstruction of
 * every prompt + every tool use. Budget: 48K chars (~12K tokens).
 *
 * If no prior session with prompts: compact summary. Budget: 16K chars (~4K tokens).
 *
 * Queries SQLite directly. No worker daemon.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { openDatabase } from '../../services/sqlite/DirectDB.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';

/** Normal mode: ~4000 tokens */
const MAX_CONTEXT_CHARS = 16000;
/** Crash recovery mode: ~12000 tokens */
const MAX_RECOVERY_CHARS = 48000;

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
  created_at_epoch: number;
}

interface SessionRow {
  content_session_id: string;
  project: string;
  status: string;
  prompt_counter: number;
  started_at: string;
  started_at_epoch: number;
}

// ─── Compact formatters (normal mode) ───────────────────────────────────

function formatObservationCompact(obs: RawObsRow): string {
  const tool = obs.tool_name;
  let input: any = obs.tool_input;
  try { input = JSON.parse(input ?? ''); } catch { /* keep as string */ }

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

// ─── Detailed formatters (crash recovery mode) ─────────────────────────

function formatObservationDetailed(obs: RawObsRow): string {
  const tool = obs.tool_name;
  let input: any = obs.tool_input;
  try { input = JSON.parse(input ?? ''); } catch { /* keep as string */ }

  const resp = obs.tool_response ?? '';
  const respPreview = resp.length > 500 ? resp.slice(0, 500) + '...' : resp;

  switch (tool) {
    case 'Write':
      return `**Write** \`${input?.file_path ?? '?'}\`\n  Content: ${(input?.content ?? '').slice(0, 300)}${(input?.content?.length ?? 0) > 300 ? '...' : ''}`;
    case 'Read':
      return `**Read** \`${input?.file_path ?? '?'}\``;
    case 'Edit':
      return `**Edit** \`${input?.file_path ?? '?'}\`\n  old: \`${(input?.old_string ?? '').slice(0, 150)}\`\n  new: \`${(input?.new_string ?? '').slice(0, 150)}\``;
    case 'Bash': {
      const cmd = input?.command ?? input ?? '';
      const cmdStr = typeof cmd === 'string' ? cmd : JSON.stringify(cmd);
      return `**Bash** \`${cmdStr.slice(0, 300)}\`\n  Output: ${respPreview}`;
    }
    case 'Glob':
      return `**Glob** \`${input?.pattern ?? ''}\`\n  Results: ${respPreview.slice(0, 300)}`;
    case 'Grep':
      return `**Grep** \`${input?.pattern ?? ''}\` in ${input?.path ?? '.'}\n  Results: ${respPreview.slice(0, 300)}`;
    case 'Task':
      return `**Task** ${input?.description ?? input?.subagent_type ?? '(agent)'}\n  Result: ${respPreview.slice(0, 300)}`;
    default: {
      const summary = typeof input === 'string' ? input.slice(0, 200) : JSON.stringify(input).slice(0, 200);
      return `**${tool}** ${summary}`;
    }
  }
}

// ─── Crash Recovery: full session reconstruction ────────────────────────

function buildRecoveryContext(
  db: any,
  crashedSession: SessionRow,
  charBudget: number
): string {
  const sid = crashedSession.content_session_id;

  // Get ALL prompts for the crashed session
  const prompts = db.prepare(
    `SELECT content_session_id, prompt_number, prompt_text, created_at, created_at_epoch
     FROM user_prompts
     WHERE content_session_id = ?
     ORDER BY prompt_number ASC`
  ).all(sid) as PromptRow[];

  // Get ALL observations for the crashed session
  const observations = db.prepare(
    `SELECT id, content_session_id, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch
     FROM raw_observations
     WHERE content_session_id = ?
     ORDER BY id ASC`
  ).all(sid) as RawObsRow[];

  // Separate assistant responses from regular tool observations
  const regularObs: RawObsRow[] = [];
  const assistantResponsesByPrompt = new Map<number, string>();

  for (const o of observations) {
    if (o.tool_name === '_assistant_responses') {
      // Parse stored assistant responses: [{prompt_number, text}, ...]
      try {
        const responses = JSON.parse(o.tool_response ?? '[]') as Array<{ prompt_number: number; text: string }>;
        for (const r of responses) {
          // Keep the latest (last stored) response per prompt
          if (!assistantResponsesByPrompt.has(r.prompt_number)) {
            assistantResponsesByPrompt.set(r.prompt_number, r.text);
          }
        }
      } catch { /* skip malformed */ }
    } else {
      regularObs.push(o);
    }
  }

  // Group regular observations by prompt_number
  const obsByPrompt = new Map<number, RawObsRow[]>();
  for (const o of regularObs) {
    const pn = o.prompt_number ?? 0;
    if (!obsByPrompt.has(pn)) obsByPrompt.set(pn, []);
    obsByPrompt.get(pn)!.push(o);
  }

  // Find all prompt numbers (from prompts, observations, and assistant responses)
  const allPromptNums = new Set<number>();
  for (const p of prompts) allPromptNums.add(p.prompt_number);
  for (const pn of obsByPrompt.keys()) allPromptNums.add(pn);
  for (const pn of assistantResponsesByPrompt.keys()) allPromptNums.add(pn);
  const sortedNums = [...allPromptNums].sort((a, b) => a - b);

  // Build prompt lookup
  const promptByNum = new Map<number, PromptRow>();
  for (const p of prompts) promptByNum.set(p.prompt_number, p);

  const lines: string[] = [];
  const statusLabel = crashedSession.status === 'active' ? 'interrupted' : 'completed';
  lines.push(`# Previous Session — ${crashedSession.project}`);
  lines.push(`Last session (${statusLabel}, started ${crashedSession.started_at}, ${crashedSession.prompt_counter} prompts, ${regularObs.length} tool uses).`);
  lines.push(`Full reconstruction below so you can continue where the user left off.\n`);

  let used = lines.join('\n').length;

  for (const pn of sortedNums) {
    if (used > charBudget - 200) {
      lines.push('\n...[context truncated — use MCP search/get_observations for more detail]');
      break;
    }

    // User prompt
    const prompt = promptByNum.get(pn);
    if (prompt) {
      const promptText = prompt.prompt_text.length > 2000
        ? prompt.prompt_text.slice(0, 2000) + '...'
        : prompt.prompt_text;
      const pLine = `\n## Prompt ${pn}\n> ${promptText.replace(/\n/g, '\n> ')}\n`;
      lines.push(pLine);
      used += pLine.length;
    }

    // Tool observations for this prompt
    const obs = obsByPrompt.get(pn);
    if (obs && obs.length > 0) {
      for (const o of obs) {
        if (used > charBudget - 200) break;
        const oLine = `- ${formatObservationDetailed(o)}\n`;
        lines.push(oLine);
        used += oLine.length;
      }
    }

    // Claude's response for this prompt
    const assistantText = assistantResponsesByPrompt.get(pn);
    if (assistantText && used < charBudget - 200) {
      const cappedText = assistantText.length > 1500
        ? assistantText.slice(0, 1500) + '...'
        : assistantText;
      const aLine = `\n**Claude's response:**\n${cappedText}\n`;
      lines.push(aLine);
      used += aLine.length;
    }
  }

  return lines.join('\n').trim();
}

// ─── Normal mode: compact recent sessions ───────────────────────────────

function buildNormalContext(
  db: any,
  sessions: SessionRow[],
  charBudget: number
): string {
  const sessionIds = sessions.map(s => s.content_session_id);
  const sessionPlaceholders = sessionIds.map(() => '?').join(',');

  const observations = db.prepare(
    `SELECT id, content_session_id, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch
     FROM raw_observations
     WHERE content_session_id IN (${sessionPlaceholders})
     ORDER BY created_at_epoch DESC
     LIMIT 50`
  ).all(...sessionIds) as RawObsRow[];

  const prompts = db.prepare(
    `SELECT content_session_id, prompt_number, prompt_text, created_at, created_at_epoch
     FROM user_prompts
     WHERE content_session_id IN (${sessionPlaceholders})
     ORDER BY created_at_epoch DESC
     LIMIT 20`
  ).all(...sessionIds) as PromptRow[];

  // Group by session
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

  const lines: string[] = [];
  lines.push('# Recent Session Activity\n');

  let remaining = charBudget;
  const sessionBudgets = sessions.map((_, i) => i === 0 ? 0.6 : 0.4 / (sessions.length - 1 || 1));

  for (let i = 0; i < sessions.length && remaining > 500; i++) {
    const s = sessions[i];
    const data = sessionMap.get(s.content_session_id);
    if (!data) continue;

    const budget = Math.floor(charBudget * sessionBudgets[i]);
    let used = 0;

    const statusTag = s.status === 'completed' ? ' (completed)' : '';
    const header = `## Session: ${s.project}${statusTag} - ${s.started_at}\n`;
    lines.push(header);
    used += header.length;

    for (const p of data.prompts.slice(0, 3)) {
      if (used > budget) break;
      const line = `- Prompt #${p.prompt_number}: ${p.prompt_text.slice(0, 200)}\n`;
      lines.push(line);
      used += line.length;
    }

    if (data.observations.length > 0) {
      lines.push('### Tool Activity:\n');
      used += 20;
      for (const obs of data.observations) {
        if (used > budget) break;
        const line = `- ${formatObservationCompact(obs)}\n`;
        lines.push(line);
        used += line.length;
      }
    }

    lines.push('');
    remaining -= used;
  }

  return lines.join('').trim();
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

      // Get recent sessions for this project (last 5)
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

      // Always do full reconstruction of the most recent session for this project.
      // This ensures you can pick up where you left off after a crash, reboot, or
      // simply starting a new session in the same directory.
      const mostRecent = sessions[0];
      const additionalContext = mostRecent.prompt_counter > 0
        ? buildRecoveryContext(db, mostRecent, MAX_RECOVERY_CHARS)
        : buildNormalContext(db, sessions, MAX_CONTEXT_CHARS);

      logger.debug('HOOK', 'Context generated', {
        mode: mostRecent.prompt_counter > 0 ? 'full' : 'summary',
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
