import path from 'path';
import { logger } from './logger.js';

/**
 * Extract project name from working directory path.
 * Uses the directory basename (e.g. /Users/me/Code/my-app → "my-app").
 */
export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  const basename = path.basename(cwd);

  if (basename === '') {
    logger.warn('PROJECT_NAME', 'Root directory detected, using fallback', { cwd });
    return 'unknown-project';
  }

  return basename;
}

/**
 * Project context for query filtering.
 */
export interface ProjectContext {
  primary: string;
  allProjects: string[];
}

/**
 * Get project context from cwd.
 */
export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const primary = getProjectName(cwd);
  return { primary, allProjects: [primary] };
}
