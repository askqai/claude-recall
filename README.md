# Claude-Recall

Persistent memory system for [Claude Code](https://claude.com/claude-code). Automatically captures tool usage, compresses observations, and injects relevant context into future sessions.

## Quick Start

```bash
claude plugin marketplace add askqai/claude-recall
claude plugin install claude-recall-plugin
```

Restart Claude Code. Memory capture begins automatically.

## How It Works

Claude-Recall hooks into Claude Code's lifecycle to build persistent memory:

1. **SessionStart** -- Loads relevant context from previous sessions
2. **UserPromptSubmit** -- Initializes session, saves user prompt
3. **PostToolUse** -- Captures observations from every tool invocation
4. **Stop** -- Generates a compressed summary when Claude stops responding
5. **SessionEnd** -- Marks session as completed when you exit Claude Code

All data is stored locally in SQLite at `~/.claude-recall/claude-recall.db`. A background worker on `localhost:37777` handles AI-powered compression and serves a web viewer UI.

### What Gets Captured

- File edits, command outputs, search results
- Architectural decisions and their rationale
- Bug fixes and what caused them
- Project discoveries and learnings

Each observation is tagged with project context (derived from working directory), so memory is isolated per project.

## Search

Claude-Recall provides MCP tools for querying history:

| Tool | Purpose |
|------|---------|
| `search` | Full-text search across observations (~50-100 tokens/result) |
| `timeline` | Chronological context around specific observations |
| `get_observations` | Fetch full details by ID (~500-1000 tokens/result) |

The 3-layer workflow (search -> timeline -> get_observations) provides ~10x token savings by filtering before fetching.

## Web Viewer

Browse your memory stream at [http://localhost:37777](http://localhost:37777) while the worker is running.

## Privacy

Wrap content in `<private>` tags to prevent it from being stored:

```
<private>API_KEY=sk-secret-value</private>
```

Tag stripping happens at the hook layer before data reaches the worker or database.

## Configuration

Settings live in `~/.claude-recall/settings.json` (auto-created on first run):

| Key | Default | Description |
|-----|---------|-------------|
| `CLAUDE_RECALL_WORKER_PORT` | `37777` | Worker API port |
| `CLAUDE_RECALL_WORKER_HOST` | `127.0.0.1` | Worker bind address |
| `CLAUDE_RECALL_LOG_LEVEL` | `INFO` | Log level (DEBUG, INFO, WARN, ERROR) |
| `DATABASE_URL` | -- | PostgreSQL connection string (tiered storage) |
| `REDIS_HOST` | -- | Redis host (tiered storage) |
| `REDIS_PORT` | -- | Redis port (tiered storage) |
| `OLLAMA_HOST` | -- | Ollama URL for embeddings (tiered storage) |

## Storage Modes

Claude-recall supports multiple storage configurations. Use the interactive dashboard to view and manage storage:

```bash
npm run storage    # Interactive dashboard
```

From the dashboard, press:
- **Enter** → Select storage mode (arrow keys)
- **c** → Configure connections (local/remote)
- **q** → Exit

### Available Modes

| Mode | Primary Storage | Description |
|------|-----------------|-------------|
| **sqlite-only** | SQLite | Local only. No network. Data stays on this machine. |
| **sqlite-primary** | SQLite → PG/Redis | Writes to SQLite first, then syncs to PostgreSQL + Redis. Safe if network fails. |
| **tiered-primary** | PG/Redis → SQLite | Writes to PostgreSQL (pgvector) + Redis first. SQLite is fallback. **Enables cross-machine sharing.** |
| **tiered-cold-only** | PG → SQLite | PostgreSQL only (no Redis). Simpler setup. |

### Storage Dashboard

Running `npm run storage` shows an interactive dashboard:

```
Storage Configuration
────────────────────────────────────────────────────────────
  ▶ Tiered Primary (Cross-Machine)

Connections
────────────────────────────────────────────────────────────
  PostgreSQL:             ● localhost:5432/claude_recall
  Redis:                  ● localhost:6379
  Ollama:                 ● http://localhost:11434 [✓ nomic-embed-text]

Data Counts
────────────────────────────────────────────────────────────
  SQLite (Local)          11 observations, 7 sessions
  PostgreSQL (pgvector)   11 observations
  Redis (Hot Cache)       5 cached, 48h TTL

Projects
────────────────────────────────────────────────────────────
  my-project              42 observations    2h ago
  another-repo            18 observations    1d ago

Press Enter to change storage mode, c to configure connections, or q to exit
```

### Quick Setup

**Local Docker (single machine):**

```bash
# Start PostgreSQL + Redis
docker compose -f docker-compose.tiered.yml up -d

# Install Ollama embedding model
ollama pull nomic-embed-text

# Run the interactive dashboard
npm run storage
# Press 'c' → select '1' for local Docker
# Press Enter → select 'tiered-primary'
```

**Cross-Machine Sharing:**

On a server, run PostgreSQL + Redis (Docker or cloud). Then on each machine:

```bash
npm run storage
# Press 'c' → select '2' for remote → enter server IP
# Press Enter → select 'tiered-primary'
```

Both machines will share context for projects with the same directory name (e.g., `~/Code/my-app` on both machines → shared context under project `my-app`).

### Architecture

- **Hot Tier (Redis)** -- RediSearch vector search, 48h TTL, ~1-5ms latency
- **Cold Tier (PostgreSQL)** -- pgvector + BM25 hybrid search, 20-day retention
- **Ollama** -- Local embedding generation with `nomic-embed-text`

See [docs/TIERED_MEMORY.md](docs/TIERED_MEMORY.md) and [docs/QUICK_START.md](docs/QUICK_START.md) for full setup guides.

## System Requirements

- **Node.js** >= 18.0.0
- **Claude Code** with plugin support
- **Bun** -- auto-installed if missing (required for bun:sqlite)

For tiered storage (optional):
- PostgreSQL 16+ with pgvector
- Redis Stack (with RediSearch)
- Ollama with nomic-embed-text

## Development

### Building from Source

```bash
git clone https://github.com/askqai/claude-recall.git
cd claude-recall
npm install
npm run build-and-sync     # Build, sync to marketplace, restart worker
```

The build process:
1. **Build** -- Compiles TypeScript to bundled CJS (`scripts/build-hooks.js`)
2. **Sync** -- Copies `plugin/` to `~/.claude/plugins/marketplaces/askqai/`
3. **Restart** -- Stops old worker, starts new one with updated code

### Commands

```bash
# Build & Deploy
npm run build              # Build only (outputs to plugin/)
npm run build-and-sync     # Build + sync + restart (full deploy)
npm run sync-marketplace   # Sync without rebuild

# Worker Management
npm run worker:start       # Start worker daemon
npm run worker:stop        # Stop worker
npm run worker:status      # Check worker status

# Storage Configuration
npm run storage            # Interactive dashboard (view & change settings)
npm run storage:set <mode> # Direct mode change (for scripting)
npm run storage:connect local   # Configure for local Docker
npm run storage:connect remote  # Configure for remote server
```

### Verifying the Build

After building, verify the version is correctly injected:
```bash
curl -s http://127.0.0.1:37777/api/version
# Should output: {"version":"X.Y.Z"} matching package.json
```

If it shows `"development"`, the build didn't inject the version correctly.

### Project Structure

```
src/
  hooks/            # Lifecycle hook handlers (TypeScript -> ESM)
  services/
    worker/         # Express API, search, agents
    storage/        # Redis hot tier, PostgreSQL cold tier
    sqlite/         # SQLite database layer
  ui/viewer/        # React web viewer
plugin/             # Built plugin output
  .claude-plugin/   # Marketplace + plugin metadata
  hooks/            # hooks.json
  scripts/          # Bundled CJS (worker-service, mcp-server, etc.)
  modes/            # Internal configuration
  ui/               # Built viewer
scripts/            # Build and sync tooling
docs/               # Documentation
```

## Troubleshooting

Describe any issue to Claude in a session and it will diagnose automatically. For manual debugging:

```bash
# Check worker status
curl http://127.0.0.1:37777/api/health
curl http://127.0.0.1:37777/api/stats

# View logs
tail -50 ~/.claude-recall/logs/claude-recall-$(date +%Y-%m-%d).log

# Generate bug report
cd ~/.claude/plugins/marketplaces/askqai
npm run bug-report
```

### Common Issues

**Observations not being stored (count stays at 0)**

Check if worker and plugin versions match:
```bash
curl -s http://127.0.0.1:37777/api/version
# Should match version in ~/.claude/plugins/marketplaces/askqai/package.json
```

If they don't match, the worker restarts on every hook invocation. Fix by rebuilding:
```bash
npm run build-and-sync
```

**Worker not starting**

Check if port 37777 is already in use:
```bash
lsof -i :37777
```

Kill any stale processes and restart:
```bash
curl -X POST http://127.0.0.1:37777/api/admin/shutdown
# Wait a few seconds, then trigger any Claude Code action
```

**"Shutdown initiated" appearing in logs frequently**

This usually indicates a version mismatch (see above). Check for:
```
[SYSTEM] Worker version mismatch detected - auto-restarting
```

**Sessions stuck in "active" status**

If Claude Code crashes or exits abnormally, sessions may remain in `active` status. Clean them up:
```bash
curl -X POST http://127.0.0.1:37777/api/admin/cleanup-sessions \
  -H "Content-Type: application/json" \
  -d '{"maxAgeHours": 2}'
```

**Queue messages stuck in "processing"**

Check queue health and clear stuck messages:
```bash
# View queue status
curl http://127.0.0.1:37777/api/pending-queue

# Clear failed messages
curl -X DELETE http://127.0.0.1:37777/api/pending-queue/failed
```

## License

[Apache-2.0](LICENSE)
