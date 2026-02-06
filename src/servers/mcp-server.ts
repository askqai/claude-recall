/**
 * Claude-recall MCP Search Server - Direct SQLite
 *
 * Queries SQLite directly instead of proxying through worker HTTP API.
 * Searches both raw_observations (new) and observations (legacy) tables.
 */

// Version injected at build time by esbuild define
declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

import { logger } from '../utils/logger.js';

// CRITICAL: Redirect console to stderr BEFORE other imports
// MCP uses stdio transport where stdout is reserved for JSON-RPC protocol messages.
const _originalLog = console['log'];
console['log'] = (...args: any[]) => {
  logger.error('CONSOLE', 'Intercepted console output (MCP protocol protection)', undefined, { args });
};

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openDatabase } from '../services/sqlite/DirectDB.js';

import type { Database, Statement } from 'bun:sqlite';

// Open database at startup — WAL mode supports concurrent readers
let db: Database;
try {
  db = openDatabase();
} catch (error) {
  logger.error('SYSTEM', 'Failed to open database', undefined, error as Error);
  process.exit(1);
}

/**
 * Prepared statement cache to avoid leaking statement handles.
 * bun:sqlite Statement objects hold native resources; creating one per request leaks memory.
 * Cache by SQL string, finalize all on shutdown.
 */
const stmtCache = new Map<string, Statement>();
function cachedPrepare(sql: string): Statement {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

function finalizeAllStatements(): void {
  for (const stmt of stmtCache.values()) {
    try { stmt.finalize(); } catch { /* ignore */ }
  }
  stmtCache.clear();
}

interface SearchRow {
  id: number;
  source: string;
  content_session_id: string;
  project: string;
  tool_name: string | null;
  title: string | null;
  type: string | null;
  created_at: string;
  created_at_epoch: number;
}

interface RawObsFullRow {
  id: number;
  content_session_id: string;
  project: string;
  tool_name: string;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}

interface LegacyObsRow {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  created_at: string;
  created_at_epoch: number;
}

/**
 * Search across both raw_observations (FTS5) and legacy observations tables.
 * Uses 4 fixed SQL variants (with/without project, with/without query) for statement caching.
 */
function handleSearch(args: Record<string, any>): { content: Array<{ type: 'text'; text: string }> } {
  const query = args.query as string || '';
  const limit = Math.min(Number(args.limit) || 20, 100);
  const project = args.project as string | undefined;
  const offset = Number(args.offset) || 0;

  const results: SearchRow[] = [];

  // Search raw_observations via FTS5
  if (query.trim()) {
    const ftsQuery = query.split(/\s+/).map(term => `"${term.replace(/"/g, '')}"`).join(' ');
    try {
      if (project) {
        const rawResults = cachedPrepare(
          `SELECT r.id, 'raw' as source, r.content_session_id, r.project, r.tool_name,
                  NULL as title, NULL as type, r.created_at, r.created_at_epoch
           FROM raw_observations r
           JOIN raw_observations_fts f ON r.id = f.rowid
           WHERE raw_observations_fts MATCH ? AND r.project = ?
           ORDER BY r.created_at_epoch DESC LIMIT ? OFFSET ?`
        ).all(ftsQuery, project, limit, offset) as SearchRow[];
        results.push(...rawResults);
      } else {
        const rawResults = cachedPrepare(
          `SELECT r.id, 'raw' as source, r.content_session_id, r.project, r.tool_name,
                  NULL as title, NULL as type, r.created_at, r.created_at_epoch
           FROM raw_observations r
           JOIN raw_observations_fts f ON r.id = f.rowid
           WHERE raw_observations_fts MATCH ?
           ORDER BY r.created_at_epoch DESC LIMIT ? OFFSET ?`
        ).all(ftsQuery, limit, offset) as SearchRow[];
        results.push(...rawResults);
      }
    } catch {
      // FTS query syntax error - fall back to LIKE
      const likePattern = `%${query}%`;
      if (project) {
        const rawResults = cachedPrepare(
          `SELECT id, 'raw' as source, content_session_id, project, tool_name,
                  NULL as title, NULL as type, created_at, created_at_epoch
           FROM raw_observations
           WHERE (tool_name LIKE ? OR tool_input LIKE ?) AND project = ?
           ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?`
        ).all(likePattern, likePattern, project, limit, offset) as SearchRow[];
        results.push(...rawResults);
      } else {
        const rawResults = cachedPrepare(
          `SELECT id, 'raw' as source, content_session_id, project, tool_name,
                  NULL as title, NULL as type, created_at, created_at_epoch
           FROM raw_observations
           WHERE (tool_name LIKE ? OR tool_input LIKE ?)
           ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?`
        ).all(likePattern, likePattern, limit, offset) as SearchRow[];
        results.push(...rawResults);
      }
    }
  } else {
    // No query: return recent raw observations
    if (project) {
      const rawResults = cachedPrepare(
        `SELECT id, 'raw' as source, content_session_id, project, tool_name,
                NULL as title, NULL as type, created_at, created_at_epoch
         FROM raw_observations WHERE project = ?
         ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?`
      ).all(project, limit, offset) as SearchRow[];
      results.push(...rawResults);
    } else {
      const rawResults = cachedPrepare(
        `SELECT id, 'raw' as source, content_session_id, project, tool_name,
                NULL as title, NULL as type, created_at, created_at_epoch
         FROM raw_observations
         ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?`
      ).all(limit, offset) as SearchRow[];
      results.push(...rawResults);
    }
  }

  // Also search legacy observations table
  try {
    if (query.trim()) {
      const likePattern = `%${query}%`;
      if (project) {
        const legacyResults = cachedPrepare(
          `SELECT id, 'legacy' as source, COALESCE(memory_session_id, '') as content_session_id,
                  project, NULL as tool_name, title, type, created_at, created_at_epoch
           FROM observations
           WHERE (title LIKE ? OR text LIKE ? OR narrative LIKE ?) AND project = ?
           ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?`
        ).all(likePattern, likePattern, likePattern, project, Math.floor(limit / 2), offset) as SearchRow[];
        results.push(...legacyResults);
      } else {
        const legacyResults = cachedPrepare(
          `SELECT id, 'legacy' as source, COALESCE(memory_session_id, '') as content_session_id,
                  project, NULL as tool_name, title, type, created_at, created_at_epoch
           FROM observations
           WHERE (title LIKE ? OR text LIKE ? OR narrative LIKE ?)
           ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?`
        ).all(likePattern, likePattern, likePattern, Math.floor(limit / 2), offset) as SearchRow[];
        results.push(...legacyResults);
      }
    } else {
      if (project) {
        const legacyResults = cachedPrepare(
          `SELECT id, 'legacy' as source, COALESCE(memory_session_id, '') as content_session_id,
                  project, NULL as tool_name, title, type, created_at, created_at_epoch
           FROM observations WHERE project = ?
           ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?`
        ).all(project, Math.floor(limit / 2), offset) as SearchRow[];
        results.push(...legacyResults);
      } else {
        const legacyResults = cachedPrepare(
          `SELECT id, 'legacy' as source, COALESCE(memory_session_id, '') as content_session_id,
                  project, NULL as tool_name, title, type, created_at, created_at_epoch
           FROM observations
           ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?`
        ).all(Math.floor(limit / 2), offset) as SearchRow[];
        results.push(...legacyResults);
      }
    }
  } catch {
    // Legacy table may not exist or have different schema
  }

  // Sort combined results by time
  results.sort((a, b) => b.created_at_epoch - a.created_at_epoch);

  // Format as compact index
  const lines = results.slice(0, limit).map(r => {
    const source = r.source === 'raw' ? 'R' : 'L';
    const tool = r.tool_name || r.type || '';
    const title = r.title || '';
    return `[${source}:${r.id}] ${r.created_at} | ${r.project} | ${tool} ${title}`.trim();
  });

  return {
    content: [{
      type: 'text' as const,
      text: lines.length > 0
        ? `Found ${results.length} results:\n\n${lines.join('\n')}\n\nUse get_observations(ids=[...]) for full details. R=raw, L=legacy.`
        : 'No results found.'
    }]
  };
}

/**
 * Timeline: get context around a specific observation or time window
 */
function handleTimeline(args: Record<string, any>): { content: Array<{ type: 'text'; text: string }> } {
  const anchor = Number(args.anchor) || 0;
  const depthBefore = Math.min(Number(args.depth_before) || 3, 20);
  const depthAfter = Math.min(Number(args.depth_after) || 3, 20);
  const project = args.project as string | undefined;
  const source = (args.source as string) || 'raw';

  if (!anchor) {
    return { content: [{ type: 'text' as const, text: 'Error: anchor (observation ID) is required' }] };
  }

  if (source === 'legacy') {
    const anchorObs = cachedPrepare('SELECT created_at_epoch, project FROM observations WHERE id = ?').get(anchor) as { created_at_epoch: number; project: string } | undefined;
    if (!anchorObs) {
      return { content: [{ type: 'text' as const, text: `Legacy observation ${anchor} not found` }] };
    }

    const epochBefore = anchorObs.created_at_epoch - 3600 * depthBefore;
    const epochAfter = anchorObs.created_at_epoch + 3600 * depthAfter;
    const rows = project
      ? cachedPrepare(
          `SELECT id, COALESCE(memory_session_id, '') as session_id, project, type, title, created_at, created_at_epoch
           FROM observations WHERE created_at_epoch >= ? AND created_at_epoch <= ? AND project = ?
           ORDER BY created_at_epoch ASC LIMIT 50`
        ).all(epochBefore, epochAfter, project) as any[]
      : cachedPrepare(
          `SELECT id, COALESCE(memory_session_id, '') as session_id, project, type, title, created_at, created_at_epoch
           FROM observations WHERE created_at_epoch >= ? AND created_at_epoch <= ?
           ORDER BY created_at_epoch ASC LIMIT 50`
        ).all(epochBefore, epochAfter) as any[];

    const lines = rows.map(r => `[L:${r.id}]${r.id === anchor ? ' >>> ' : ' '}${r.created_at} | ${r.project} | ${r.type} ${r.title || ''}`);
    return { content: [{ type: 'text' as const, text: lines.join('\n') || 'No timeline data found.' }] };
  }

  // Raw observations timeline
  const anchorObs = cachedPrepare('SELECT created_at_epoch, project FROM raw_observations WHERE id = ?').get(anchor) as { created_at_epoch: number; project: string } | undefined;
  if (!anchorObs) {
    return { content: [{ type: 'text' as const, text: `Raw observation ${anchor} not found` }] };
  }

  const epochBefore = anchorObs.created_at_epoch - 3600 * depthBefore;
  const epochAfter = anchorObs.created_at_epoch + 3600 * depthAfter;
  const rows = project
    ? cachedPrepare(
        `SELECT id, content_session_id, project, tool_name, created_at, created_at_epoch
         FROM raw_observations WHERE created_at_epoch >= ? AND created_at_epoch <= ? AND project = ?
         ORDER BY created_at_epoch ASC LIMIT 50`
      ).all(epochBefore, epochAfter, project) as any[]
    : cachedPrepare(
        `SELECT id, content_session_id, project, tool_name, created_at, created_at_epoch
         FROM raw_observations WHERE created_at_epoch >= ? AND created_at_epoch <= ?
         ORDER BY created_at_epoch ASC LIMIT 50`
      ).all(epochBefore, epochAfter) as any[];

  const lines = rows.map((r: any) => `[R:${r.id}]${r.id === anchor ? ' >>> ' : ' '}${r.created_at} | ${r.project} | ${r.tool_name}`);

  return { content: [{ type: 'text' as const, text: lines.join('\n') || 'No timeline data found.' }] };
}

/**
 * Parse prefixed IDs (e.g. "R:1", "L:5") into { source, id } pairs.
 * Accepts both prefixed strings and plain numbers.
 */
function parseIds(ids: Array<string | number>): { rawIds: number[]; legacyIds: number[] } {
  const rawIds: number[] = [];
  const legacyIds: number[] = [];
  for (const id of ids) {
    const s = String(id).trim();
    if (s.startsWith('R:') || s.startsWith('r:')) {
      const num = Number(s.slice(2));
      if (!isNaN(num) && num > 0) rawIds.push(num);
    } else if (s.startsWith('L:') || s.startsWith('l:')) {
      const num = Number(s.slice(2));
      if (!isNaN(num) && num > 0) legacyIds.push(num);
    } else {
      const num = Number(s);
      if (!isNaN(num) && num > 0) {
        // No prefix — search both tables
        rawIds.push(num);
        legacyIds.push(num);
      }
    }
  }
  return { rawIds: rawIds.slice(0, 50), legacyIds: legacyIds.slice(0, 50) };
}

/**
 * Get full details for specific observation IDs.
 * IDs can be prefixed: R:1 (raw), L:5 (legacy), or plain numbers (search both).
 */
function handleGetObservations(args: Record<string, any>): { content: Array<{ type: 'text'; text: string }> } {
  const ids = args.ids as Array<string | number>;
  if (!ids || ids.length === 0) {
    return { content: [{ type: 'text' as const, text: 'Error: ids array is required' }] };
  }

  const { rawIds, legacyIds } = parseIds(ids);
  const results: any[] = [];

  // Fetch from raw_observations
  if (rawIds.length > 0) {
    const rawPlaceholders = rawIds.map(() => '?').join(',');
    const rawRows = db.prepare(
      `SELECT * FROM raw_observations WHERE id IN (${rawPlaceholders}) ORDER BY created_at_epoch DESC`
    ).all(...rawIds) as RawObsFullRow[];

    for (const r of rawRows) {
      results.push({
        source: 'raw',
        id: r.id,
        session: r.content_session_id,
        project: r.project,
        tool_name: r.tool_name,
        tool_input: r.tool_input ? truncate(r.tool_input, 2000) : null,
        tool_response: r.tool_response ? truncate(r.tool_response, 2000) : null,
        cwd: r.cwd,
        prompt_number: r.prompt_number,
        created_at: r.created_at
      });
    }
  }

  // Fetch from legacy observations
  if (legacyIds.length > 0) {
    try {
      const legacyPlaceholders = legacyIds.map(() => '?').join(',');
      const legacyRows = db.prepare(
        `SELECT * FROM observations WHERE id IN (${legacyPlaceholders}) ORDER BY created_at_epoch DESC`
      ).all(...legacyIds) as LegacyObsRow[];

      for (const r of legacyRows) {
        results.push({
          source: 'legacy',
          id: r.id,
          session: r.memory_session_id,
          project: r.project,
          type: r.type,
          title: r.title,
          subtitle: r.subtitle,
          text: r.text ? truncate(r.text, 1000) : null,
          facts: r.facts,
          narrative: r.narrative ? truncate(r.narrative, 1000) : null,
          created_at: r.created_at
        });
      }
    } catch {
      // Legacy table may not exist
    }
  }

  return {
    content: [{
      type: 'text' as const,
      text: results.length > 0
        ? JSON.stringify(results, null, 2)
        : `No observations found for IDs: ${ids.join(', ')}`
    }]
  };
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '...[truncated]' : s;
}

/**
 * Tool definitions
 */
const tools = [
  {
    name: '__IMPORTANT',
    description: `3-LAYER WORKFLOW (ALWAYS FOLLOW):
1. search(query) → Get index with IDs (~50-100 tokens/result)
2. timeline(anchor=ID) → Get context around interesting results
3. get_observations([IDs]) → Fetch full details ONLY for filtered IDs
NEVER fetch full details without filtering first. 10x token savings.`,
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async () => ({
      content: [{
        type: 'text' as const,
        text: `# Memory Search Workflow

**3-Layer Pattern (ALWAYS follow this):**

1. **Search** - Get index of results with IDs
   \`search(query="...", limit=20, project="...")\`
   Returns: Table with IDs, dates (~50-100 tokens/result)

2. **Timeline** - Get context around interesting results
   \`timeline(anchor=<ID>, depth_before=3, depth_after=3)\`
   Returns: Chronological context

3. **Fetch** - Get full details ONLY for relevant IDs
   \`get_observations(ids=[...])\`
   Returns: Complete details (~500-1000 tokens/result)

**Why:** 10x token savings. Never fetch full details without filtering first.
Prefix R: = raw observations, L: = legacy observations.`
      }]
    })
  },
  {
    name: 'search',
    description: 'Step 1: Search memory. Returns index with IDs. Params: query, limit, project, offset',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (FTS5 for raw observations, LIKE for legacy)' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
        project: { type: 'string', description: 'Filter by project name' },
        offset: { type: 'number', description: 'Pagination offset' }
      },
      additionalProperties: true
    },
    handler: async (args: any) => handleSearch(args)
  },
  {
    name: 'timeline',
    description: 'Step 2: Get context around results. Params: anchor (observation ID), depth_before, depth_after, project, source (raw|legacy)',
    inputSchema: {
      type: 'object',
      properties: {
        anchor: { type: 'number', description: 'Observation ID to center timeline on' },
        depth_before: { type: 'number', description: 'Hours before anchor (default 3)' },
        depth_after: { type: 'number', description: 'Hours after anchor (default 3)' },
        project: { type: 'string', description: 'Filter by project name' },
        source: { type: 'string', description: 'raw (default) or legacy' }
      },
      required: ['anchor'],
      additionalProperties: true
    },
    handler: async (args: any) => handleTimeline(args)
  },
  {
    name: 'get_observations',
    description: 'Step 3: Fetch full details for filtered IDs. Params: ids (array of observation IDs)',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { oneOf: [{ type: 'number' }, { type: 'string' }] },
          description: 'Array of observation IDs — use R:1 for raw, L:5 for legacy, or plain numbers'
        }
      },
      required: ['ids'],
      additionalProperties: true
    },
    handler: async (args: any) => handleGetObservations(args)
  }
];

// Create the MCP server
const server = new Server(
  {
    name: 'mcp-search-server',
    version: packageVersion,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tools/list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  };
});

// Register tools/call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find(t => t.name === request.params.name);

  if (!tool) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  try {
    return await tool.handler(request.params.arguments || {});
  } catch (error) {
    logger.error('SYSTEM', 'Tool execution failed', { tool: request.params.name }, error as Error);
    return {
      content: [{
        type: 'text' as const,
        text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
});

// Cleanup function
async function cleanup() {
  logger.info('SYSTEM', 'MCP server shutting down');
  finalizeAllStatements();
  try { db.close(); } catch { /* ignore */ }
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('SYSTEM', 'Claude-recall search server started (direct SQLite mode)');
}

main().catch((error) => {
  logger.error('SYSTEM', 'Fatal error', undefined, error);
  process.exit(0);
});
