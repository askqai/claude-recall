# Claude-Recall

Persistent memory system for [Claude Code](https://claude.com/claude-code). Automatically captures every tool use, stores user prompts, and injects relevant context into future sessions.

All data stays local in a single SQLite database. No background daemons, no network services, no subprocess spawning.

**Inspired by [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)** — rebuilt from the ground up with a zero-daemon, lightweight-first philosophy.

## What Makes This Different

| Feature | claude-recall | claude-mem | Others |
|---------|:---:|:---:|:---:|
| **One-command install** (`/plugin install claude-recall`) | **Yes** | Yes | Varies |
| **Full-fidelity session recovery** (24h window, up to 1M tokens) | **Yes** | No (lossy AI summary only) | No |
| **Zero API token cost** (no AI compression calls) | **Yes** | No (uses Claude Agent SDK) | Varies |
| Zero background daemons | Yes | No (Express server) | Varies |
| No Python/Chroma required | Yes | No | Varies |
| Direct SQLite (WAL mode) | Yes | HTTP proxy | Varies |
| Smart relevance scoring | Yes | No | No |
| Auto-redaction of secrets | Yes | No | No |
| Privacy suppression tags | Yes | Partial | No |
| Memory consolidation/decay | Yes | No | No |
| Cross-project search | Yes | No | No |
| Token-efficient 3-layer search | Yes | Yes | No |
| Single dependency (MCP SDK) | Yes | No (15+ deps) | Varies |
| **License** | **Apache 2.0** | AGPL-3.0 | Varies |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Claude Code                                                         │
│                                                                     │
│  Hook (SessionStart)      → Reads SQLite  → Injects context        │
│  Hook (UserPromptSubmit)  → Writes SQLite → Records session+prompt  │
│  Hook (PostToolUse)       → Writes SQLite → Records tool use        │
│  Hook (Stop)              → Reads transcript → Captures responses   │
│  Hook (SessionEnd)        → Writes SQLite → Marks session done      │
│                                                                     │
│  MCP Server (stdio)       → Reads SQLite  → search/timeline/forget  │
└─────────────────────────────────────────────────────────────────────┘
         │                           │
         ▼                           ▼
┌─────────────────┐    ┌──────────────────────────┐
│ bun:sqlite (WAL) │    │ ~/.claude-recall/         │
│ Direct access    │───▶│   claude-recall.db        │
│ No HTTP proxy    │    │   logs/                   │
└─────────────────┘    └──────────────────────────┘
```

There is no background worker, no HTTP server, no AI-powered compression. Hooks write directly to SQLite via `bun:sqlite` in WAL mode. The MCP server is launched by Claude Code on demand via stdio transport.

## Features

### 1. Smart Selective Capture

Every tool use is scored for relevance (0.0–1.0) before storage:

| Score | What triggers it |
|-------|-----------------|
| 0.8–0.9 | Write/Edit operations, Bash errors, tool uses following bug/fix/architecture prompts |
| 0.5 | Standard reads, successful Bash commands (default) |
| 0.1–0.2 | Config file reads (package.json, tsconfig), empty search results, node_modules, duplicate reads |
| 0.0 | Internal bookkeeping (_assistant_responses) |

Relevance scores drive cleanup priority — low-signal observations are deleted first when the database exceeds 10GB.

### 2. Privacy & Security

**Suppression tags** — Include `<private>` or `<no-recall>` in any prompt to suppress storage for that prompt and all subsequent tool uses until the next prompt:
```
<private> Show me the API keys in .env
```
Nothing from that interaction is stored.

**Auto-redaction** — Sensitive patterns are automatically detected and replaced with `[REDACTED:label]` before storage:

| Pattern | Example |
|---------|---------|
| API keys | `api_key=sk_live_abc123...` → `[REDACTED:API_KEY]` |
| Bearer tokens | `Bearer eyJhbGci...` → `[REDACTED:BEARER_TOKEN]` |
| AWS keys | `AKIAIOSFODNN7...` → `[REDACTED:AWS_KEY]` |
| Private keys | `-----BEGIN RSA PRIVATE KEY-----` → `[REDACTED:PRIVATE_KEY]` |
| Passwords | `password="hunter2"` → `[REDACTED:PASSWORD]` |
| GitHub tokens | `ghp_xxxx...` → `[REDACTED:GITHUB_TOKEN]` |
| OpenAI keys | `sk-xxxx...` → `[REDACTED:OPENAI_KEY]` |
| Slack tokens | `xoxb-xxxx...` → `[REDACTED:SLACK_TOKEN]` |

**Retroactive deletion** — The `forget` MCP tool deletes matching observations:
```
forget(query="credentials", confirm=false)   # dry run — shows what would be deleted
forget(query="credentials", confirm=true)    # actually deletes
forget(ids=["R:42", "R:43"], confirm=true)   # delete specific observations
```

### 3. Memory Decay & Consolidation

Memory lifecycle is managed automatically based on **session count, not time** — so a project you pause for weeks keeps full history until you push it out with new sessions:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 1: Consolidation (count-based, per project)                   │
│   Keep last 20 sessions with full raw detail per project            │
│   Session 21+ → compressed into ~500 char summaries                 │
│   Raw observations and user prompts deleted                         │
│                                                                     │
│ Layer 2: Decay (time-based)                                         │
│   Observations > 90 days → relevance scores halved (floor at 0.05)  │
│   Idempotent — scores converge toward floor over repeated runs      │
│                                                                     │
│ Layer 3: Hard Size Limit (safety net — always enforced)             │
│   DB > 10GB → delete lowest-relevance observations first            │
│   Fires regardless of consolidation or decay state                  │
│   Catches runaway sessions, unclosed sessions, edge cases           │
└─────────────────────────────────────────────────────────────────────┘
```

**Why count-based, not time-based?** If you pause a project for 3 weeks and come back, all your sessions are still there with full raw detail. Consolidation only kicks in when you create session #21 for that project — time alone never triggers data loss.

**Why a hard 10GB limit?** Sessions can grow large, stay unclosed, or accumulate across many projects. The 10GB cap is the safety net that always fires, deleting lowest-relevance observations first regardless of age or session count.

All three layers run probabilistically (1% of PostToolUse invocations) to avoid overhead.

### 4. Cross-Project Search

Search across all projects with the MCP `search` tool:
```
search(query="auth middleware", cross_project=true)
```

By default, context injection and search are scoped to the current project (derived from the working directory). Cross-project is opt-in only.

### 5. Session Recovery & Context Injection

When a new session starts, claude-recall picks one of two modes automatically based on how recent your last activity was:

#### Recovery Mode (recent activity within 24 hours)

If you crashed, lost power, hit auto-update, or just closed Claude Code and came back — the next session **dumps your last 24 hours of activity in full fidelity**. No searching, no AI summarization, no lossy compression. You're back exactly where you left off.

```markdown
# Session Recovery — my-app
Last activity: 23 minutes ago. Recovered 1 session(s) from the last 24 hours.
This is a full-fidelity dump of recent work — pick up where you left off.

---
## Session 2026-04-26 14:30:00 UTC (interrupted) — 12 prompt(s), 87 tool use(s)

### Prompt 1
> Fix the authentication timeout bug in the login flow

**Claude:** Looking at src/auth/middleware.ts, I found the JWT expiry logic
expects seconds but the env var is in milliseconds. Let me trace through...
[FULL response, not truncated]

#### Tool uses
- **Read** src/auth/middleware.ts
- **Edit** src/auth/jwt.ts
- **Bash**: `npm test`

### Prompt 2
> Now make sure the refresh handles edge cases
[continues...]
```

**Configurable via env vars:**
```bash
CLAUDE_RECALL_RECOVERY_WINDOW_HOURS=24      # how recent counts as "recovery"
CLAUDE_RECALL_RECOVERY_BUDGET_TOKENS=200000 # max tokens to inject (default 200K)
                                             # set to 1000000 if on extended (1M) context
```

The system dumps everything within the window **up to** the budget — it doesn't pad to fill it. A 40K-token session injects 40K, not 200K.

#### Summary Mode (no recent activity)

When you're returning to a project after days or weeks, you don't need the full transcript — you need orientation. claude-recall falls back to a compact ~2K token summary:

```markdown
# Previous Session — my-app
Status: completed | Started: 2026-03-15T14:30:00Z | 5 prompts, 23 tool uses
Use MCP tools (search, timeline, get_observations) for full details.

## Prompt 1
> Fix the authentication timeout bug in the login flow
**Claude:** The issue was in src/auth/middleware.ts where the JWT expiry...

### Files touched (8): src/auth/middleware.ts, src/auth/jwt.ts...
### Commands run (3): npm test, git diff...

## Older Sessions (consolidated)
- **2026-02-20** (12p/45t): Refactor database connection pooling...
```

Full detail is always available on-demand via MCP tools.

**Why two modes?** Human memory works the same way: "what was I just doing?" needs total recall; "what did I work on last month?" only needs the gist. claude-recall mirrors that distinction automatically.

#### How This Compares to `claude --continue` / `claude --resume`

Claude Code already ships with native session restoration:

```bash
claude --continue                      # resume your last conversation in this directory
claude --resume                        # interactive picker of past sessions
claude --resume "session-name"         # resume a specifically named session
```

These are excellent for **single-session continuity** — same conversation, full history, picks up exactly where you left off.

**Where Recovery Mode adds value beyond `--continue` / `--resume`:**

| Scenario | `--continue` / `--resume` | claude-recall |
|----------|:---:|:---:|
| Crashed mid-session, want exact thread back | ✅ Perfect | Redundant |
| **Multi-session feature work** (e.g. 3 sessions over 2 days) | ❌ Resumes ONE session | ✅ Aggregates all sessions in window |
| **Fresh conversation, but with awareness** of recent work | ❌ All-or-nothing — forces you back into old thread | ✅ Structured context, clean chat |
| **Auto-compaction loss** (Claude Code compresses long sessions) | ❌ Pre-compaction detail is gone forever | ✅ Raw observations preserved separately |
| Don't remember which session had the work | ❌ Have to scroll/pick | ✅ Auto-injected on any new session |
| Search past activity programmatically | ❌ Not available | ✅ MCP `search`, `timeline`, `get_observations` |
| Selectively forget something | ❌ All-or-nothing | ✅ `forget()` MCP tool |
| Auto-redact API keys/tokens before storage | ❌ Stores everything verbatim | ✅ Built-in redaction |
| Privacy suppression (`<private>` tags) | ❌ Not available | ✅ Built-in |

**Different problems, different tools:**

- **`--continue`** answers *"where was I in **this conversation**?"*
- **claude-recall Recovery Mode** answers *"where am I in **this project**?"*

The killer use case isn't "I crashed." It's **"I want a clean conversation today that knows what I did yesterday."** `--continue` forces you back into the old thread; Recovery Mode lets you start fresh with awareness — useful when context bloat or off-track conversations make you want to start over without losing the work.

For multi-session features (which is most real work), Recovery Mode aggregates 3-5 recent sessions into one orienting context block — something `--resume` simply can't do because it operates on one session at a time.

## Installation

### Quickstart (Plugin Marketplace)

```text
/plugin marketplace add askqai/claude-recall
/plugin install claude-recall
```

That's it. Restart Claude Code and Recovery Mode will start working automatically. The plugin includes hooks (data capture) and the MCP server (search/forget tools) — both registered in one step.

**Prerequisite:** [Bun](https://bun.sh) must be installed (`curl -fsSL https://bun.sh/install | bash`). Everything else is bundled.

### What's Installed

claude-recall has two parts that work together:

| Part | What it does |
|------|-------------|
| **Hooks** | Capture every tool use, prompt, and response automatically (5 lifecycle hooks) |
| **MCP Server** | Lets Claude search, recover, and forget memory (`search`, `timeline`, `get_observations`, `forget`) |

The plugin marketplace install registers both automatically.

### Verify

```bash
# Check the database was created after your first session
ls -la ~/.claude-recall/claude-recall.db

# Confirm observations are landing
sqlite3 ~/.claude-recall/claude-recall.db "SELECT COUNT(*) FROM raw_observations;"
```

### Inside a Claude Code Session

Once installed, you can ask Claude things like:

- *"Search my memory for the auth bug fix"* — Claude calls `mcp__claude-recall__search`
- *"What did I work on yesterday in the workweek repo?"* — `search` with project filter
- *"Search across all repos for stripe webhook"* — `search` with `cross_project=true`
- *"Forget any observations mentioning my-old-api-key"* — `forget` tool
- *"Show me the timeline around when I last touched login.ts"* — `timeline` tool

The MCP tools are visible to Claude as `mcp__claude-recall__*`.

---

## Manual Installation (Advanced / Development)

For local development or if you prefer to manage the install yourself.

### Prerequisites

| Dependency | Version | Why |
|-----------|---------|-----|
| **Bun** | >= 1.0 | Runtime for hooks and MCP server (`bun:sqlite`) |
| **Node.js** | >= 18 | Build step only (esbuild) |
| **Claude Code** | Latest | With hooks support |

### Step 1: Install Bun (if not already installed)

```bash
curl -fsSL https://bun.sh/install | bash
```

Verify it's working:
```bash
bun --version
```

### Step 2: Clone and Build

```bash
git clone https://github.com/askqai/claude-recall.git
cd claude-recall
npm install
node scripts/build-hooks.js
```

You should see:
```
  ✓ hook-command.js
  ✓ mcp-server.cjs
Build complete
```

Note the **absolute path** to your clone — you'll need it in the next steps:
```bash
pwd
# Example output: /Users/you/Code/claude-recall
```

### Step 3: Configure Claude Code Hooks

Open (or create) `~/.claude/settings.json` and add the hooks configuration.

Replace `/absolute/path/to/claude-recall` below with the output from `pwd` in Step 2:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"/absolute/path/to/claude-recall/plugin/scripts/bun-runner.sh\" \"/absolute/path/to/claude-recall/plugin/scripts/hook-command.js\" claude-code context",
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
            "command": "\"/absolute/path/to/claude-recall/plugin/scripts/bun-runner.sh\" \"/absolute/path/to/claude-recall/plugin/scripts/hook-command.js\" claude-code session-init",
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
            "command": "\"/absolute/path/to/claude-recall/plugin/scripts/bun-runner.sh\" \"/absolute/path/to/claude-recall/plugin/scripts/hook-command.js\" claude-code observation",
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
            "command": "\"/absolute/path/to/claude-recall/plugin/scripts/bun-runner.sh\" \"/absolute/path/to/claude-recall/plugin/scripts/hook-command.js\" claude-code summarize",
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
            "command": "\"/absolute/path/to/claude-recall/plugin/scripts/bun-runner.sh\" \"/absolute/path/to/claude-recall/plugin/scripts/hook-command.js\" claude-code session-end",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

> **Tip:** If you already have a `settings.json` with other hooks, merge the hook arrays — don't replace the entire file.

### Step 4: Configure the MCP Server

Open (or create) `~/.claude.json` and add the MCP server:

```json
{
  "mcpServers": {
    "claude-recall": {
      "type": "stdio",
      "command": "/absolute/path/to/claude-recall/plugin/scripts/bun-runner.sh",
      "args": ["/absolute/path/to/claude-recall/plugin/scripts/mcp-server.cjs"]
    }
  }
}
```

> **Note:** `~/.claude.json` is the **global** Claude Code config (not the per-project `.claude/settings.json`). If the file doesn't exist, create it with the JSON above.

### Step 5: Restart Claude Code

Close and reopen Claude Code (or start a new session). You should see the previous session summary injected at the start of your conversation.

### Verify Installation

```bash
# Check the database was created
ls -la ~/.claude-recall/claude-recall.db

# Check recent observations are being stored
sqlite3 ~/.claude-recall/claude-recall.db "SELECT COUNT(*) FROM raw_observations;"

# Check sessions are tracked
sqlite3 ~/.claude-recall/claude-recall.db "SELECT project, status, prompt_counter FROM sdk_sessions ORDER BY rowid DESC LIMIT 5;"
```

### Quick Test

Test the hook manually to confirm everything is wired up:
```bash
echo '{"session_id":"test","tool_name":"Read","tool_input":{"file_path":"/tmp/test"},"tool_response":"ok","cwd":"/tmp"}' | \
  bun /path/to/claude-recall/plugin/scripts/hook-command.js claude-code observation
```

Expected output:
```json
{"continue":true,"suppressOutput":true}
```

### One-Shot Validation

Confirm both hooks AND the MCP server are correctly registered:

```bash
python3 -c "
import json
print('=== Hooks ===')
with open('$HOME/.claude/settings.json') as f:
    hooks = json.load(f).get('hooks', {})
for event in ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']:
    print(f'  {\"✓\" if event in hooks else \"✗\"} {event}')

print()
print('=== MCP Server ===')
with open('$HOME/.claude.json') as f:
    servers = json.load(f).get('mcpServers', {})
if 'claude-recall' in servers:
    print('  ✓ claude-recall registered')
else:
    print('  ✗ claude-recall not found')
"
```

If everything is configured correctly, all 5 hooks should show ✓ and `claude-recall` should be registered.

## How It Works

### Hook Lifecycle

| Hook | Event | What It Does |
|------|-------|-------------|
| `SessionStart` | New session opens | Queries recent sessions from SQLite, builds compact summary (~2K tokens), injects as context |
| `UserPromptSubmit` | User sends a prompt | Creates/updates session, increments prompt counter, stores prompt (checks privacy tags) |
| `PostToolUse` | Any tool completes | Scores relevance, redacts secrets, stores observation. 1% chance: runs consolidation + decay + cleanup |
| `Stop` | Claude stops responding | Reads conversation transcript, extracts assistant responses, stores as `_assistant_responses` |
| `SessionEnd` | Session exits | Marks session status as `completed` |

### Observation Pipeline

```
PostToolUse fires
    │
    ▼
Check privacy_suppressed flag ──── Yes ──→ Skip (return early)
    │ No
    ▼
Truncate payloads (10KB cap)
    │
    ▼
Detect & redact sensitive patterns
    │
    ▼
Query recent tools (last 5) for dedup
    │
    ▼
Compute relevance score (0.0-1.0)
    │
    ▼
INSERT into raw_observations
    │
    ▼
1% chance: consolidate + decay + cleanup
```

### Relevance Scoring Logic

The scoring system uses simple heuristics — no ML, no API calls:

- **Tool type**: Write/Edit score higher than Read. Bash errors score higher than successes.
- **Content analysis**: Config files (package.json, tsconfig) score low. Code files score normal.
- **Dedup detection**: Repeated reads of the same file within a session get penalized.
- **Prompt context**: If the user's last prompt mentioned "bug", "fix", "architecture", etc., all subsequent tool uses get a +0.15 boost.

### Memory Consolidation

When a project exceeds 20 completed sessions, the oldest sessions beyond that limit are compressed into the `consolidated_sessions` table:

1. Find projects with >20 completed sessions that have raw observations
2. For sessions beyond the 20-session retention limit (oldest first):
   - Build a compressed summary from prompts (~500 chars)
   - Extract metadata: files touched, commands run, prompt/tool counts
   - Store summary in `consolidated_sessions`
   - Delete raw observations and user prompts for that session
3. Process up to 5 sessions per invocation to stay within hook timeout

This is count-based, not time-based — a project you haven't touched in weeks retains full detail until new sessions push older ones past the limit. The 10GB hard cap acts as an independent safety net regardless.

## MCP Tools

The MCP server provides five tools following a 3-layer workflow for token-efficient retrieval:

### `search` — Find observations

```
search(query="authentication bug", project="my-app", limit=20)
search(query="database migration", cross_project=true)
```

Returns a compact index with IDs:
```
Found 23 results:

[R:142] 2026-03-27T14:30:00Z | my-app | Edit src/auth/jwt.ts
[R:140] 2026-03-27T14:25:30Z | my-app | Bash npm test
[C:3] 2026-03-20T10:00:00Z | my-app | (consolidated session)
[L:15] 2026-01-28T14:00:00Z | my-app | feature Add login flow

Use get_observations(ids=[...]) for full details. R=raw, L=legacy, C=consolidated.
```

### `timeline` — Context around a result

```
timeline(anchor=142, depth_before=3, depth_after=3)
```

Returns chronological context (hours before/after the anchor):
```
[R:140] 2026-03-27T14:25:00Z | my-app | Read
[R:141] 2026-03-27T14:29:55Z | my-app | Bash
[R:142] >>> 2026-03-27T14:30:00Z | my-app | Edit    ← anchor
[R:143] 2026-03-27T14:30:10Z | my-app | Bash
```

### `get_observations` — Full details

```
get_observations(ids=["R:142", "R:141", "C:3"])
```

Returns complete records with tool input, response, cwd, etc. Accepts prefixed IDs:
- `R:` — raw observations
- `L:` — legacy observations
- `C:` — consolidated sessions

### `forget` — Delete observations

```
forget(query="api keys", confirm=false)    # preview what would be deleted
forget(ids=["R:42"], confirm=true)         # delete specific observations
```

### Recommended Workflow

1. **Search** — Get index with IDs (~50-100 tokens per result)
2. **Timeline** — Get surrounding context for interesting results
3. **Get Observations** — Fetch full details only for filtered IDs

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
  tool_input TEXT,              -- JSON, capped at 10KB
  tool_response TEXT,           -- capped at 10KB
  cwd TEXT,
  prompt_number INTEGER,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  relevance_score REAL DEFAULT 0.5,   -- 0.0-1.0, drives cleanup priority
  redacted INTEGER DEFAULT 0          -- 1 if sensitive content was redacted
);
```

**`sdk_sessions`** — One row per Claude Code session:
```sql
CREATE TABLE sdk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT UNIQUE NOT NULL,
  project TEXT NOT NULL,
  status TEXT DEFAULT 'active',         -- active | completed | failed
  prompt_counter INTEGER DEFAULT 0,
  privacy_suppressed INTEGER DEFAULT 0, -- 1 = suppress storage for current prompt
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
  prompt_text TEXT NOT NULL,         -- "[PRIVATE]" if privacy tag was used
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);
```

**`consolidated_sessions`** — Compressed summaries of old sessions:
```sql
CREATE TABLE consolidated_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  summary TEXT NOT NULL,             -- ~500 char compressed prompt history
  prompt_count INTEGER,
  tool_use_count INTEGER,
  files_touched TEXT,                -- JSON array
  commands_run TEXT,                 -- JSON array
  original_started_at TEXT,
  original_started_at_epoch INTEGER NOT NULL,
  consolidated_at TEXT NOT NULL,
  consolidated_at_epoch INTEGER NOT NULL
);
```

**`observations`** — Legacy table from the old AI-compressed system. Still queryable via MCP `search` and `get_observations` with `L:` prefix.

### Full-Text Search

Both `raw_observations` and `user_prompts` have FTS5 virtual tables with automatic sync triggers:
- `raw_observations_fts` — indexes `tool_name` and `tool_input`
- `user_prompts_fts` — indexes `prompt_text`

### Storage Limits

- **Max DB size:** 10 GB hard limit (enforced by page count check, always active)
- **Consolidation:** Per project, keeps last 20 sessions with full detail; older ones compressed into summaries
- **Decay:** Observations >90 days have relevance scores halved (floor at 0.05)
- **Cleanup strategy:** When DB exceeds 10GB, deletes by lowest `relevance_score` first, then oldest
- **Cleanup frequency:** All three layers run probabilistically on ~1% of PostToolUse invocations
- **Input/response cap:** 10 KB per field (larger payloads truncated with `...[truncated]` marker)

### SQLite Configuration

```sql
PRAGMA journal_mode = WAL;       -- Concurrent readers + single writer
PRAGMA busy_timeout = 5000;      -- Wait 5s for locks instead of failing
PRAGMA synchronous = NORMAL;     -- Safe with WAL, better performance
PRAGMA foreign_keys = ON;
PRAGMA temp_store = memory;
```

WAL mode allows multiple Claude Code sessions to read simultaneously while one writes.

## Project Structure

```
src/
  cli/
    hook-entry.ts              -- CLI entry point (parses argv)
    hook-command.ts            -- Routes events to handlers
    stdin-reader.ts            -- Reads JSON from stdin
    types.ts                   -- NormalizedHookInput, HookResult types
    handlers/
      context.ts               -- SessionStart: context injection + consolidated summaries
      session-init.ts          -- UserPromptSubmit: session + prompt storage + privacy check
      observation.ts           -- PostToolUse: relevance scoring + redaction + storage + maintenance
      summarize.ts             -- Stop: transcript capture
      session-end.ts           -- SessionEnd: mark session completed
      relevance.ts             -- Relevance scoring heuristics (0.0-1.0)
      user-message.ts          -- SessionStart: user notification via stderr
      file-edit.ts             -- Cursor: afterFileEdit hook
    adapters/
      claude-code.ts           -- Normalizes Claude Code hook input
      cursor.ts                -- Normalizes Cursor hook input
      raw.ts                   -- Pass-through adapter
  servers/
    mcp-server.ts              -- MCP server (search, timeline, get_observations, forget)
  services/
    sqlite/
      DirectDB.ts              -- openDatabase() — thin wrapper for bun:sqlite
      migrations/
        runner.ts              -- Schema migrations (24 versions)
    consolidation.ts           -- Session consolidation, time decay, smart cleanup
  utils/
    privacy.ts                 -- Private prompt detection, sensitive pattern redaction
    logger.ts                  -- Structured file + stderr logger
    project-name.ts            -- Derives project name from cwd
  shared/
    paths.ts                   -- DB_PATH, DATA_DIR, LOG_DIR constants
    SettingsDefaultsManager.ts -- Default settings and env var overrides
    hook-constants.ts          -- Exit codes, timeouts

plugin/
  scripts/
    hook-command.js            -- Built ESM bundle (hooks entry point)
    mcp-server.cjs             -- Built CJS bundle (MCP server)
    bun-runner.sh              -- Resolves bun binary path
  hooks/
    hooks.json                 -- Hook definitions (template)

scripts/
  build-hooks.js               -- esbuild script (builds all bundles)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_RECALL_DATA_DIR` | `~/.claude-recall` | Data directory for DB and logs |
| `CLAUDE_RECALL_LOG_LEVEL` | `INFO` | Log verbosity (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_RECALL_RECOVERY_WINDOW_HOURS` | `24` | How recent activity must be to trigger Recovery Mode |
| `CLAUDE_RECALL_RECOVERY_BUDGET_TOKENS` | `200000` | Max tokens injected in Recovery Mode (set `1000000` for extended context) |
| `CLAUDE_RECALL_WORKER_PORT` | `37777` | Legacy — not used in direct SQLite mode |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code config directory |

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

### Database locked errors

Multiple concurrent writes can cause lock contention. The `busy_timeout=5000` pragma handles most cases. If persistent:
```bash
lsof ~/.claude-recall/claude-recall.db
```

### Checking database size

```bash
sqlite3 ~/.claude-recall/claude-recall.db \
  "SELECT (page_count * page_size / 1024 / 1024) || ' MB' as size FROM pragma_page_count(), pragma_page_size();"
```

### Viewing recent activity

```bash
# Recent observations with relevance scores
sqlite3 ~/.claude-recall/claude-recall.db \
  "SELECT id, project, tool_name, relevance_score, created_at FROM raw_observations ORDER BY id DESC LIMIT 10;"

# Recent sessions
sqlite3 ~/.claude-recall/claude-recall.db \
  "SELECT content_session_id, project, status, prompt_counter, privacy_suppressed, started_at FROM sdk_sessions ORDER BY rowid DESC LIMIT 10;"

# Consolidated sessions
sqlite3 ~/.claude-recall/claude-recall.db \
  "SELECT id, project, prompt_count, tool_use_count, original_started_at FROM consolidated_sessions ORDER BY id DESC LIMIT 10;"

# Check for redacted observations
sqlite3 ~/.claude-recall/claude-recall.db \
  "SELECT COUNT(*) as redacted_count FROM raw_observations WHERE redacted = 1;"
```

## Privacy

All data is stored locally on disk at `~/.claude-recall/`. Nothing is sent to external services. The MCP server communicates only via stdio (no network).

Sensitive content (API keys, tokens, passwords) is automatically redacted before storage. Use `<private>` tags to suppress storage entirely for sensitive interactions.

## License

[Apache-2.0](LICENSE)

Copyright 2026 Workweek — Richard Chow <askqai@mitns.com>
