/**
 * Hook CLI entry point - parses process.argv and calls hookCommand.
 *
 * Usage: bun hook-command.js <platform> <event>
 * Example: bun hook-command.js claude-code observation
 */
import { hookCommand } from './hook-command.js';

const platform = process.argv[2];
const event = process.argv[3];

if (!platform || !event) {
  console.error('Usage: hook-command <platform> <event>');
  console.error('Platforms: claude-code, cursor, raw');
  console.error('Events: context, session-init, observation, summarize, session-end, user-message');
  process.exit(1);
}

hookCommand(platform, event);
