# Claude-Recall

Persistent memory system for [Claude Code](https://claude.com/claude-code). Automatically captures every tool use, stores user prompts, and injects relevant context into future sessions.

All data stays local in a single SQLite database. No background daemons, no network services, no subprocess spawning.

## Architecture

```
Hook (SessionStart)     → Reads SQLite → Injects context into new session
Hook (UserPromptSubmit) → Writes SQLite → Records session + user prompt
Hook (PostToolUse)      → Writes SQLite → Records tool name, input, response
Hook (Stop)             → No-op
Hook (SessionEnd)       → Writes SQLite → Marks session completed

MCP Server (stdio)      → Reads SQLite → search / timeline / get_observations
```

There is no background worker, no HTTP server, no AI-powered compression. Hooks write directly to SQLite via `bun:sqlite` in WAL mode. The MCP server is launched by Claude Code on demand via stdio transport.

## Installation

### Prerequisites

- **Bun** >= 1.0 (required for `bun:sqlite`)
- **Claude Code** with hooks support
- **Node.js** >= 18 (for the build step only)

Install Bun if not already installed:
```bash
curl -fsSL https://bun.sh/install | bash
```

### Build

```bash
cd /Users/richardchow/Code/claude-recall-new
npm install
node scripts/build-hooks.js
```

This produces four bundles in `plugin/scripts/`:
- `hook-command.js` — ESM entry point for all hooks
- `mcp-server.cjs` — MCP server (stdio transport)
- `worker-service.cjs` — Legacy, not used
- `context-generator.cjs` — Legacy, not used

### Deploy

**1. Hooks** — Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"/Users/richardchow/Code/claude-recall-new/plugin/scripts/bun-runner.sh\" \"/Users/richardchow/Code/claude-recall-new/plugin/scripts/hook-command.js\" claude-code context",
            "timeout": 10
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/Users/richardchow/Code/claude-recall-new/plugin/scripts/bun-runner.sh\" \"/Users/richardchow/Code/claude-recall-new/plugin/scripts/hook-command.js\" claude-code session-init",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "\"/Users/richardchow/Code/claude-recall-new/plugin/scripts/bun-runner.sh\" \"/Users/richardchow/Code/claude-recall-new/plugin/scripts/hook-command.js\" claude-code observation",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/Users/richardchow/Code/claude-recall-new/plugin/scripts/bun-runner.sh\" \"/Users/richardchow/Code/claude-recall-new/plugin/scripts/hook-command.js\" claude-code summarize",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/Users/richardchow/Code/claude-recall-new/plugin/scripts/bun-runner.sh\" \"/Users/richardchow/Code/claude-recall-new/plugin/scripts/hook-command.js\" claude-code session-end",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

**2. MCP Server** — Add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "claude-recall": {
      "type": "stdio",
      "command": "/Users/richardchow/Code/claude-recall-new/plugin/scripts/bun-runner.sh",
      "args": ["/Users/richardchow/Code/claude-recall-new/plugin/scripts/mcp-server.cjs"]
    }
  }
}
```

**3. Restart Claude Code** — Existing sessions must be restarted to pick up hook and MCP changes.

## How It Works

### Hook Lifecycle

| Hook | Event | What It Does |
|------|-------|-------------|
| `SessionStart` | New session opens | Queries recent sessions and observations from SQLite, formats as markdown, injects as context (~4000 tokens max) |
| `UserPromptSubmit` | User sends a prompt | Creates/updates session in `sdk_sessions`, increments prompt counter, stores prompt text in `user_prompts` |
| `PostToolUse` | Any tool completes | Inserts tool name, input (capped 10KB), response (capped 10KB) into `raw_observations` |
| `Stop` | Claude stops responding | No-op (raw observations already capture everything) |
| `SessionEnd` | Session exits | Marks session status as `completed` |

### Context Injection (SessionStart)

When a new session starts, the context handler:

1. Queries the 5 most recent sessions from `sdk_sessions`
2. For each session, fetches associated `raw_observations` and `user_prompts`
3. Groups observations by session, allocates 60% of budget to the most recent session
4. Applies tool-specific formatters:
   - **Read/Write/Edit** — shows file path
   - **Bash** — shows command + truncated output
   - **Glob/Grep** — shows search pattern
5. Returns formatted markdown as `hookSpecificOutput.additionalContext`

Max context size: 16,000 characters (~4,000 tokens).

### Observation Storage (PostToolUse)

Every tool invocation is captured with:
- `tool_name` — Read, Write, Edit, Bash, Grep, Glob, etc.
- `tool_input` — JSON of the tool's input parameters (capped at 10KB)
- `tool_response` — The tool's output (capped at 10KB)
- `content_session_id` — Links to the Claude Code session
- `project` — Derived from working directory name
- `cwd` — Full working directory path
- `prompt_number` — Which prompt in the session triggered this tool use

### Session Separation

Each Claude Code session gets a unique `content_session_id`. Observations and prompts are tagged with this ID, so multiple concurrent sessions (even in the same project) are cleanly separated in the database. The `project` column (derived from the working directory basename) groups data by project for cross-session queries.

## MCP Tools

The MCP server provides three tools following a 3-layer workflow for token-efficient retrieval:

### 1. `search` — Find observations

```
search(query="authentication bug", project="my-app", limit=20)
```

Returns a compact index with IDs:
```
[R:42] 2026-02-06T10:30:00Z | my-app | Edit fix_auth.py
[R:41] 2026-02-06T10:29:55Z | my-app | Bash pytest tests/
[L:15] 2026-01-28T14:00:00Z | my-app | bug_fix Authentication timeout
```

- `R:` prefix = raw observation (new system)
- `L:` prefix = legacy observation (old system)
- Uses FTS5 full-text search on `tool_name` and `tool_input`
- Falls back to LIKE search if FTS5 query syntax fails
- Also searches legacy `observations` table

### 2. `timeline` — Context around a result

```
timeline(anchor=42, depth_before=3, depth_after=3, source="raw")
```

Returns chronological context (hours before/after the anchor):
```
[R:40] 2026-02-06T10:29:00Z | my-app | Read
[R:41] 2026-02-06T10:29:55Z | my-app | Bash
[R:42] >>> 2026-02-06T10:30:00Z | my-app | Edit    ← anchor
[R:43] 2026-02-06T10:30:10Z | my-app | Bash
```

### 3. `get_observations` — Full details

```
get_observations(ids=["R:42", "R:41", "L:15"])
```

Returns complete records with tool input, response, cwd, etc. Accepts prefixed IDs (`R:` for raw, `L:` for legacy) or plain numbers (searches both tables).

### Recommended Workflow

1. **Search** — Get index with IDs (~50-100 tokens per result)
2. **Timeline** — Get surrounding context for interesting results
3. **Get Observations** — Fetch full details only for filtered IDs (~500-1000 tokens per result)

This 3-layer pattern provides ~10x token savings compared to fetching everything upfront.

## Database

### Location

```
~/.claude-recall/claude-recall.db
```

Single shared database for all projects. Data is filtered by the `project` column at query time.

### Schema (Key Tables)

**`raw_observations`** — Every tool use from PostToolUse hooks:
```sql
CREATE TABLE raw_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input TEXT,          -- JSON, capped at 10KB
  tool_response TEXT,       -- capped at 10KB
  cwd TEXT,
  prompt_number INTEGER,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);
```

**`sdk_sessions`** — One row per Claude Code session:
```sql
CREATE TABLE sdk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT UNIQUE NOT NULL,
  project TEXT NOT NULL,
  status TEXT DEFAULT 'active',  -- active | completed | failed
  prompt_counter INTEGER DEFAULT 0,
  started_at TEXT NOT NULL,
  started_at_epoch INTEGER NOT NULL,
  completed_at TEXT,
  completed_at_epoch INTEGER
);
```

**`user_prompts`** — Every user message:
```sql
CREATE TABLE user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);
```

**`observations`** — Legacy table from the old AI-compressed system. Still queryable via MCP `search` and `get_observations` with `L:` prefix.

### Full-Text Search

Both `raw_observations` and `user_prompts` have FTS5 virtual tables with automatic sync triggers:
- `raw_observations_fts` — indexes `tool_name` and `tool_input`
- `user_prompts_fts` — indexes `prompt_text`

### Storage Limits

- **Max DB size:** 10 GB (enforced by page count check)
- **Cleanup:** When the 10 GB limit is exceeded, the oldest 10% of `raw_observations` are deleted
- **Cleanup frequency:** Probabilistic — runs on ~1% of PostToolUse invocations to avoid overhead
- **Input/response cap:** 10 KB per field (larger payloads are truncated with `...[truncated]` marker)

### SQLite Configuration

The database is opened with these pragmas:
```sql
PRAGMA journal_mode = WAL;       -- Concurrent readers + single writer
PRAGMA busy_timeout = 5000;      -- Wait 5s for locks instead of failing
PRAGMA synchronous = NORMAL;     -- Safe with WAL, better performance
PRAGMA foreign_keys = ON;
PRAGMA temp_store = memory;
```

WAL mode allows multiple Claude Code sessions to read simultaneously while one writes. Each hook opens a connection, performs its operation, and closes it. The MCP server keeps a persistent connection open.

## Project Structure

```
src/
  cli/
    hook-entry.ts          -- CLI entry point (parses argv, calls hookCommand)
    hook-command.ts        -- Routes events to handlers
    handlers/
      context.ts           -- SessionStart: context injection
      session-init.ts      -- UserPromptSubmit: session + prompt storage
      observation.ts       -- PostToolUse: raw observation storage
      summarize.ts         -- Stop: no-op
      session-end.ts       -- SessionEnd: mark session completed
    adapters/
      claude-code.ts       -- Normalizes Claude Code hook input
    types.ts               -- NormalizedHookInput types
    stdin-reader.ts        -- Reads JSON from stdin
  servers/
    mcp-server.ts          -- MCP server (stdio, direct SQLite)
  services/
    sqlite/
      DirectDB.ts          -- openDatabase() — thin wrapper for bun:sqlite
      migrations/
        runner.ts          -- Schema migrations (21 versions)
  shared/
    paths.ts               -- DB_PATH, DATA_DIR, LOG_DIR constants
  utils/
    logger.ts              -- File + stderr logger
    project-name.ts        -- Derives project name from cwd

plugin/
  scripts/
    hook-command.js        -- Built ESM bundle (hooks entry point)
    mcp-server.cjs         -- Built CJS bundle (MCP server)
    bun-runner.sh          -- Resolves bun binary path
    worker-service.cjs     -- Legacy (not used)
    context-generator.cjs  -- Legacy (not used)
  hooks/
    hooks.json             -- Hook definitions (template with ${CLAUDE_PLUGIN_ROOT})

scripts/
  build-hooks.js           -- esbuild script (builds all bundles)
```

## Building from Source

```bash
git clone https://github.com/askqai/claude-recall.git
cd claude-recall
npm install
node scripts/build-hooks.js
```

The build produces:
- `plugin/scripts/hook-command.js` — ESM format, ~65 KB
- `plugin/scripts/mcp-server.cjs` — CJS format, ~760 KB
- Type declaration errors during build are pre-existing and non-fatal

After building, update the paths in `~/.claude/settings.json` and `~/.claude.json` to point to your clone location.

## Troubleshooting

### Hooks not firing

Check that `~/.claude/settings.json` has the hooks config and paths are correct:
```bash
cat ~/.claude/settings.json | python3 -m json.tool
```

Verify bun is accessible:
```bash
~/.bun/bin/bun --version
```

### Observations not being stored

Test the hook manually:
```bash
echo '{"session_id":"test","tool_name":"Read","tool_input":{"file_path":"/tmp/test"},"tool_response":"ok","cwd":"/tmp"}' | \
  ~/.bun/bin/bun plugin/scripts/hook-command.js claude-code observation
# Should output: {"continue":true,"suppressOutput":true}
```

Check the database:
```bash
sqlite3 ~/.claude-recall/claude-recall.db "SELECT COUNT(*) FROM raw_observations;"
```

### MCP server not connecting

Test the MCP server directly:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | \
  ~/.bun/bin/bun plugin/scripts/mcp-server.cjs
```

Check the MCP config in `~/.claude.json`:
```bash
python3 -c "import json; c=json.load(open('$HOME/.claude.json')); print(json.dumps(c.get('mcpServers',{}), indent=2))"
```

### Database locked errors

Multiple concurrent writes can cause lock contention. The `busy_timeout=5000` pragma should handle most cases. If you see persistent lock errors:
```bash
# Check for stuck processes
lsof ~/.claude-recall/claude-recall.db
```

### Sessions stuck in "active"

If Claude Code crashes, sessions remain active. This is harmless — the context handler queries by recency, not status. To clean up manually:
```bash
sqlite3 ~/.claude-recall/claude-recall.db "UPDATE sdk_sessions SET status='completed' WHERE status='active' AND started_at_epoch < strftime('%s','now') - 86400;"
```

### Checking database size

```bash
sqlite3 ~/.claude-recall/claude-recall.db "SELECT (page_count * page_size / 1024 / 1024) || ' MB' as size FROM pragma_page_count(), pragma_page_size();"
```

### Viewing recent activity

```bash
# Recent observations
sqlite3 ~/.claude-recall/claude-recall.db "SELECT id, project, tool_name, created_at FROM raw_observations ORDER BY id DESC LIMIT 10;"

# Recent sessions
sqlite3 ~/.claude-recall/claude-recall.db "SELECT content_session_id, project, status, prompt_counter, started_at FROM sdk_sessions ORDER BY rowid DESC LIMIT 10;"

# Recent prompts
sqlite3 ~/.claude-recall/claude-recall.db "SELECT content_session_id, prompt_number, substr(prompt_text, 1, 80), created_at FROM user_prompts ORDER BY id DESC LIMIT 10;"
```

## Privacy

All data is stored locally on disk at `~/.claude-recall/`. Nothing is sent to external services. The MCP server communicates only via stdio (no network).

## License

[Apache-2.0](LICENSE)
