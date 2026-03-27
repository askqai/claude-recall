/**
 * Relevance Scoring Module
 *
 * Computes a 0.0-1.0 relevance score for each tool use observation.
 * Used by the observation handler to prioritize what matters in context
 * injection and cleanup. Pure heuristics — no ML, no API calls.
 */

/** Config files that are read frequently but rarely signal-bearing */
const LOW_SIGNAL_FILES = new Set([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'tsconfig.json', 'tsconfig.build.json', '.eslintrc', '.eslintrc.js', '.eslintrc.json',
  '.prettierrc', '.prettierrc.js', '.prettierrc.json', '.editorconfig',
  'jest.config.js', 'jest.config.ts', 'vitest.config.ts',
  '.gitignore', '.npmrc', '.nvmrc', '.env.example',
  'Makefile', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'README.md', 'LICENSE', 'CHANGELOG.md',
]);

/** Keywords in user prompts that indicate high-signal context */
const HIGH_SIGNAL_PROMPT_KEYWORDS = /\b(bug|fix|broke|broken|error|crash|fail|issue|decision|architect|design|refactor|migrate|security|vulnerab|incident|rollback|revert)\b/i;

export interface RelevanceInput {
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
  recentTools: Array<{ tool_name: string; tool_input: string | null }>;
  lastPromptText?: string;
}

/**
 * Compute a relevance score (0.0-1.0) for an observation.
 */
export function computeRelevanceScore(params: RelevanceInput): number {
  const { toolName, toolInput, toolResponse, recentTools, lastPromptText } = params;

  // Internal bookkeeping — always 0
  if (toolName === '_assistant_responses') return 0.0;

  let score = 0.5; // default: neutral

  const input = normalizeInput(toolInput);
  const response = normalizeResponse(toolResponse);

  // --- Tool-specific scoring ---

  if (toolName === 'Write' || toolName === 'Edit') {
    // Actual code changes are high signal
    score = 0.8;
  } else if (toolName === 'Read') {
    score = scoreRead(input);
  } else if (toolName === 'Glob' || toolName === 'Grep') {
    score = scoreSearch(response);
  } else if (toolName === 'Bash') {
    score = scoreBash(response);
  }

  // --- Dedup penalty: repeated Read of same file in recent tools ---
  if (toolName === 'Read' && input.file_path) {
    const dupeCount = recentTools.filter(t => {
      if (t.tool_name !== 'Read') return false;
      try {
        const prev = JSON.parse(t.tool_input ?? '{}');
        return prev.file_path === input.file_path;
      } catch { return false; }
    }).length;
    if (dupeCount > 0) {
      score = Math.min(score, 0.2);
    }
  }

  // --- Prompt context boost ---
  if (lastPromptText && HIGH_SIGNAL_PROMPT_KEYWORDS.test(lastPromptText)) {
    score = Math.min(1.0, score + 0.15);
  }

  return Math.round(score * 100) / 100; // 2 decimal places
}

function normalizeInput(toolInput: unknown): Record<string, any> {
  if (toolInput == null) return {};
  if (typeof toolInput === 'string') {
    try { return JSON.parse(toolInput); } catch { return {}; }
  }
  if (typeof toolInput === 'object') return toolInput as Record<string, any>;
  return {};
}

function normalizeResponse(toolResponse: unknown): string {
  if (toolResponse == null) return '';
  if (typeof toolResponse === 'string') return toolResponse;
  return JSON.stringify(toolResponse);
}

function scoreRead(input: Record<string, any>): number {
  const filePath: string = input.file_path ?? '';

  // node_modules reads are noise
  if (filePath.includes('node_modules/')) return 0.1;

  // Check if it's a common config file
  const basename = filePath.split('/').pop() ?? '';
  if (LOW_SIGNAL_FILES.has(basename)) return 0.1;

  return 0.5;
}

function scoreSearch(response: string): number {
  // Empty results = low signal
  if (!response || response === 'No results found.' || response.includes('0 results')) {
    return 0.1;
  }
  return 0.5;
}

function scoreBash(response: string): number {
  const lower = response.toLowerCase();
  // Errors are high signal — something went wrong
  if (lower.includes('error') || lower.includes('failed') ||
      lower.includes('exit code') || lower.includes('command not found') ||
      lower.includes('permission denied') || lower.includes('fatal:')) {
    return 0.8;
  }
  return 0.5;
}
