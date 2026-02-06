/**
 * Summarize Handler - Stop
 *
 * No-op: raw observations already capture everything during the session.
 * No worker daemon, no AI summarization, no subprocess spawning.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';

export const summarizeHandler: EventHandler = {
  async execute(_input: NormalizedHookInput): Promise<HookResult> {
    return { continue: true, suppressOutput: true };
  }
};
