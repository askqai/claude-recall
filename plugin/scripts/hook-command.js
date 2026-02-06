// src/cli/stdin-reader.ts
async function readJsonFromStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      try {
        resolve(input.trim() ? JSON.parse(input) : void 0);
      } catch (e) {
        reject(new Error(`Failed to parse hook input: ${e}`));
      }
    });
  });
}

// src/cli/adapters/claude-code.ts
var claudeCodeAdapter = {
  normalizeInput(raw) {
    const r = raw ?? {};
    return {
      sessionId: r.session_id,
      cwd: r.cwd ?? process.cwd(),
      prompt: r.prompt,
      toolName: r.tool_name,
      toolInput: r.tool_input,
      toolResponse: r.tool_response,
      transcriptPath: r.transcript_path
    };
  },
  formatOutput(result) {
    if (result.hookSpecificOutput) {
      return { hookSpecificOutput: result.hookSpecificOutput };
    }
    return { continue: result.continue ?? true, suppressOutput: result.suppressOutput ?? true };
  }
};

// src/cli/adapters/cursor.ts
var cursorAdapter = {
  normalizeInput(raw) {
    const r = raw ?? {};
    const isShellCommand = !!r.command && !r.tool_name;
    return {
      sessionId: r.conversation_id || r.generation_id,
      // conversation_id preferred
      cwd: r.workspace_roots?.[0] ?? process.cwd(),
      // First workspace root
      prompt: r.prompt,
      toolName: isShellCommand ? "Bash" : r.tool_name,
      toolInput: isShellCommand ? { command: r.command } : r.tool_input,
      toolResponse: isShellCommand ? { output: r.output } : r.result_json,
      // result_json not tool_response
      transcriptPath: void 0,
      // Cursor doesn't provide transcript
      // Cursor-specific fields for file edits
      filePath: r.file_path,
      edits: r.edits
    };
  },
  formatOutput(result) {
    return { continue: result.continue ?? true };
  }
};

// src/cli/adapters/raw.ts
var rawAdapter = {
  normalizeInput(raw) {
    const r = raw;
    return {
      sessionId: r.sessionId ?? r.session_id ?? "unknown",
      cwd: r.cwd ?? process.cwd(),
      prompt: r.prompt,
      toolName: r.toolName ?? r.tool_name,
      toolInput: r.toolInput ?? r.tool_input,
      toolResponse: r.toolResponse ?? r.tool_response,
      transcriptPath: r.transcriptPath ?? r.transcript_path,
      filePath: r.filePath ?? r.file_path,
      edits: r.edits
    };
  },
  formatOutput(result) {
    return result;
  }
};

// src/cli/adapters/index.ts
function getPlatformAdapter(platform2) {
  switch (platform2) {
    case "claude-code":
      return claudeCodeAdapter;
    case "cursor":
      return cursorAdapter;
    case "raw":
      return rawAdapter;
    default:
      throw new Error(`Unknown platform: ${platform2}`);
  }
}

// src/services/sqlite/DirectDB.ts
import { Database } from "bun:sqlite";

// src/shared/paths.ts
import { join as join3, dirname as dirname2, basename } from "path";
import { homedir as homedir3 } from "os";
import { mkdirSync as mkdirSync3 } from "fs";
import { fileURLToPath } from "url";

// src/shared/SettingsDefaultsManager.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// src/constants/observation-metadata.ts
var DEFAULT_OBSERVATION_TYPES_STRING = "bugfix,feature,refactor,discovery,decision,change";
var DEFAULT_OBSERVATION_CONCEPTS_STRING = "how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off";

// src/shared/SettingsDefaultsManager.ts
var SettingsDefaultsManager = class {
  /**
   * Default values for all settings
   */
  static DEFAULTS = {
    CLAUDE_RECALL_MODEL: "claude-sonnet-4-5",
    CLAUDE_RECALL_CONTEXT_OBSERVATIONS: "50",
    CLAUDE_RECALL_WORKER_PORT: "37777",
    CLAUDE_RECALL_WORKER_HOST: "127.0.0.1",
    CLAUDE_RECALL_SKIP_TOOLS: "ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",
    // AI Provider Configuration
    CLAUDE_RECALL_PROVIDER: "claude",
    // Default to Claude
    CLAUDE_RECALL_GEMINI_API_KEY: "",
    // Empty by default, can be set via UI or env
    CLAUDE_RECALL_GEMINI_MODEL: "gemini-2.5-flash-lite",
    // Default Gemini model (highest free tier RPM)
    CLAUDE_RECALL_GEMINI_RATE_LIMITING_ENABLED: "true",
    // Rate limiting ON by default for free tier users
    CLAUDE_RECALL_OPENROUTER_API_KEY: "",
    // Empty by default, can be set via UI or env
    CLAUDE_RECALL_OPENROUTER_MODEL: "xiaomi/mimo-v2-flash:free",
    // Default OpenRouter model (free tier)
    CLAUDE_RECALL_OPENROUTER_SITE_URL: "",
    // Optional: for OpenRouter analytics
    CLAUDE_RECALL_OPENROUTER_APP_NAME: "claude-recall",
    // App name for OpenRouter analytics
    CLAUDE_RECALL_OPENROUTER_MAX_CONTEXT_MESSAGES: "20",
    // Max messages in context window
    CLAUDE_RECALL_OPENROUTER_MAX_TOKENS: "100000",
    // Max estimated tokens (~100k safety limit)
    // System Configuration
    CLAUDE_RECALL_DATA_DIR: join(homedir(), ".claude-recall"),
    CLAUDE_RECALL_LOG_LEVEL: "INFO",
    CLAUDE_RECALL_PYTHON_VERSION: "3.13",
    CLAUDE_CODE_PATH: "",
    // Empty means auto-detect via 'which claude'
    CLAUDE_RECALL_MODE: "code",
    // Default mode profile
    // Token Economics
    CLAUDE_RECALL_CONTEXT_SHOW_READ_TOKENS: "true",
    CLAUDE_RECALL_CONTEXT_SHOW_WORK_TOKENS: "true",
    CLAUDE_RECALL_CONTEXT_SHOW_SAVINGS_AMOUNT: "true",
    CLAUDE_RECALL_CONTEXT_SHOW_SAVINGS_PERCENT: "true",
    // Observation Filtering
    CLAUDE_RECALL_CONTEXT_OBSERVATION_TYPES: DEFAULT_OBSERVATION_TYPES_STRING,
    CLAUDE_RECALL_CONTEXT_OBSERVATION_CONCEPTS: DEFAULT_OBSERVATION_CONCEPTS_STRING,
    // Display Configuration
    CLAUDE_RECALL_CONTEXT_FULL_COUNT: "5",
    CLAUDE_RECALL_CONTEXT_FULL_FIELD: "narrative",
    CLAUDE_RECALL_CONTEXT_SESSION_COUNT: "10",
    // Feature Toggles
    CLAUDE_RECALL_CONTEXT_SHOW_LAST_SUMMARY: "true",
    CLAUDE_RECALL_CONTEXT_SHOW_LAST_MESSAGE: "false"
  };
  /**
   * Get all defaults as an object
   */
  static getAllDefaults() {
    return { ...this.DEFAULTS };
  }
  /**
   * Get a default value from defaults (no environment variable override)
   */
  static get(key) {
    return this.DEFAULTS[key];
  }
  /**
   * Get an integer default value
   */
  static getInt(key) {
    const value = this.get(key);
    return parseInt(value, 10);
  }
  /**
   * Get a boolean default value
   */
  static getBool(key) {
    const value = this.get(key);
    return value === "true";
  }
  /**
   * Load settings from file with fallback to defaults
   * Returns merged settings with defaults as fallback
   * Handles all errors (missing file, corrupted JSON, permissions) by returning defaults
   */
  static loadFromFile(settingsPath) {
    try {
      if (!existsSync(settingsPath)) {
        const defaults = this.getAllDefaults();
        try {
          const dir = dirname(settingsPath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), "utf-8");
          console.log("[SETTINGS] Created settings file with defaults:", settingsPath);
        } catch (error) {
          console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:", settingsPath, error);
        }
        return defaults;
      }
      const settingsData = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(settingsData);
      let flatSettings = settings;
      if (settings.env && typeof settings.env === "object") {
        flatSettings = settings.env;
        try {
          writeFileSync(settingsPath, JSON.stringify(flatSettings, null, 2), "utf-8");
          console.log("[SETTINGS] Migrated settings file from nested to flat schema:", settingsPath);
        } catch (error) {
          console.warn("[SETTINGS] Failed to auto-migrate settings file:", settingsPath, error);
        }
      }
      const result = { ...this.DEFAULTS };
      for (const key of Object.keys(this.DEFAULTS)) {
        if (flatSettings[key] !== void 0) {
          result[key] = flatSettings[key];
        }
      }
      return result;
    } catch (error) {
      console.warn("[SETTINGS] Failed to load settings, using defaults:", settingsPath, error);
      return this.getAllDefaults();
    }
  }
};

// src/utils/logger.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2 } from "fs";
import { join as join2 } from "path";
import { homedir as homedir2 } from "os";
var LogLevel = /* @__PURE__ */ ((LogLevel2) => {
  LogLevel2[LogLevel2["DEBUG"] = 0] = "DEBUG";
  LogLevel2[LogLevel2["INFO"] = 1] = "INFO";
  LogLevel2[LogLevel2["WARN"] = 2] = "WARN";
  LogLevel2[LogLevel2["ERROR"] = 3] = "ERROR";
  LogLevel2[LogLevel2["SILENT"] = 4] = "SILENT";
  return LogLevel2;
})(LogLevel || {});
var DEFAULT_DATA_DIR = join2(homedir2(), ".claude-recall");
var Logger = class {
  level = null;
  useColor;
  logFilePath = null;
  logFileInitialized = false;
  constructor() {
    this.useColor = process.stdout.isTTY ?? false;
  }
  /**
   * Initialize log file path and ensure directory exists (lazy initialization)
   */
  ensureLogFileInitialized() {
    if (this.logFileInitialized) return;
    this.logFileInitialized = true;
    try {
      const logsDir = join2(DEFAULT_DATA_DIR, "logs");
      if (!existsSync2(logsDir)) {
        mkdirSync2(logsDir, { recursive: true });
      }
      const date = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      this.logFilePath = join2(logsDir, `claude-recall-${date}.log`);
    } catch (error) {
      console.error("[LOGGER] Failed to initialize log file:", error);
      this.logFilePath = null;
    }
  }
  /**
   * Lazy-load log level from settings file
   * Uses direct file reading to avoid circular dependency with SettingsDefaultsManager
   */
  getLevel() {
    if (this.level === null) {
      try {
        const settingsPath = join2(DEFAULT_DATA_DIR, "settings.json");
        if (existsSync2(settingsPath)) {
          const settingsData = readFileSync2(settingsPath, "utf-8");
          const settings = JSON.parse(settingsData);
          const envLevel = (settings.CLAUDE_RECALL_LOG_LEVEL || "INFO").toUpperCase();
          this.level = LogLevel[envLevel] ?? 1 /* INFO */;
        } else {
          this.level = 1 /* INFO */;
        }
      } catch (error) {
        this.level = 1 /* INFO */;
      }
    }
    return this.level;
  }
  /**
   * Create correlation ID for tracking an observation through the pipeline
   */
  correlationId(sessionId, observationNum) {
    return `obs-${sessionId}-${observationNum}`;
  }
  /**
   * Create session correlation ID
   */
  sessionId(sessionId) {
    return `session-${sessionId}`;
  }
  /**
   * Format data for logging - create compact summaries instead of full dumps
   */
  formatData(data) {
    if (data === null || data === void 0) return "";
    if (typeof data === "string") return data;
    if (typeof data === "number") return data.toString();
    if (typeof data === "boolean") return data.toString();
    if (typeof data === "object") {
      if (data instanceof Error) {
        return this.getLevel() === 0 /* DEBUG */ ? `${data.message}
${data.stack}` : data.message;
      }
      if (Array.isArray(data)) {
        return `[${data.length} items]`;
      }
      const keys = Object.keys(data);
      if (keys.length === 0) return "{}";
      if (keys.length <= 3) {
        return JSON.stringify(data);
      }
      return `{${keys.length} keys: ${keys.slice(0, 3).join(", ")}...}`;
    }
    return String(data);
  }
  /**
   * Format a tool name and input for compact display
   */
  formatTool(toolName, toolInput) {
    if (!toolInput) return toolName;
    let input = toolInput;
    if (typeof toolInput === "string") {
      try {
        input = JSON.parse(toolInput);
      } catch {
        input = toolInput;
      }
    }
    if (toolName === "Bash" && input.command) {
      return `${toolName}(${input.command})`;
    }
    if (input.file_path) {
      return `${toolName}(${input.file_path})`;
    }
    if (input.notebook_path) {
      return `${toolName}(${input.notebook_path})`;
    }
    if (toolName === "Glob" && input.pattern) {
      return `${toolName}(${input.pattern})`;
    }
    if (toolName === "Grep" && input.pattern) {
      return `${toolName}(${input.pattern})`;
    }
    if (input.url) {
      return `${toolName}(${input.url})`;
    }
    if (input.query) {
      return `${toolName}(${input.query})`;
    }
    if (toolName === "Task") {
      if (input.subagent_type) {
        return `${toolName}(${input.subagent_type})`;
      }
      if (input.description) {
        return `${toolName}(${input.description})`;
      }
    }
    if (toolName === "Skill" && input.skill) {
      return `${toolName}(${input.skill})`;
    }
    if (toolName === "LSP" && input.operation) {
      return `${toolName}(${input.operation})`;
    }
    return toolName;
  }
  /**
   * Format timestamp in local timezone (YYYY-MM-DD HH:MM:SS.mmm)
   */
  formatTimestamp(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
  }
  /**
   * Core logging method
   */
  log(level, component, message, context, data) {
    if (level < this.getLevel()) return;
    this.ensureLogFileInitialized();
    const timestamp = this.formatTimestamp(/* @__PURE__ */ new Date());
    const levelStr = LogLevel[level].padEnd(5);
    const componentStr = component.padEnd(6);
    let correlationStr = "";
    if (context?.correlationId) {
      correlationStr = `[${context.correlationId}] `;
    } else if (context?.sessionId) {
      correlationStr = `[session-${context.sessionId}] `;
    }
    let dataStr = "";
    if (data !== void 0 && data !== null) {
      if (data instanceof Error) {
        dataStr = this.getLevel() === 0 /* DEBUG */ ? `
${data.message}
${data.stack}` : ` ${data.message}`;
      } else if (this.getLevel() === 0 /* DEBUG */ && typeof data === "object") {
        dataStr = "\n" + JSON.stringify(data, null, 2);
      } else {
        dataStr = " " + this.formatData(data);
      }
    }
    let contextStr = "";
    if (context) {
      const { sessionId, memorySessionId, correlationId, ...rest } = context;
      if (Object.keys(rest).length > 0) {
        const pairs = Object.entries(rest).map(([k, v]) => `${k}=${v}`);
        contextStr = ` {${pairs.join(", ")}}`;
      }
    }
    const logLine = `[${timestamp}] [${levelStr}] [${componentStr}] ${correlationStr}${message}${contextStr}${dataStr}`;
    if (this.logFilePath) {
      try {
        appendFileSync(this.logFilePath, logLine + "\n", "utf8");
      } catch (error) {
        process.stderr.write(`[LOGGER] Failed to write to log file: ${error}
`);
      }
    } else {
      process.stderr.write(logLine + "\n");
    }
  }
  // Public logging methods
  debug(component, message, context, data) {
    this.log(0 /* DEBUG */, component, message, context, data);
  }
  info(component, message, context, data) {
    this.log(1 /* INFO */, component, message, context, data);
  }
  warn(component, message, context, data) {
    this.log(2 /* WARN */, component, message, context, data);
  }
  error(component, message, context, data) {
    this.log(3 /* ERROR */, component, message, context, data);
  }
  /**
   * Log data flow: input → processing
   */
  dataIn(component, message, context, data) {
    this.info(component, `\u2192 ${message}`, context, data);
  }
  /**
   * Log data flow: processing → output
   */
  dataOut(component, message, context, data) {
    this.info(component, `\u2190 ${message}`, context, data);
  }
  /**
   * Log successful completion
   */
  success(component, message, context, data) {
    this.info(component, `\u2713 ${message}`, context, data);
  }
  /**
   * Log failure
   */
  failure(component, message, context, data) {
    this.error(component, `\u2717 ${message}`, context, data);
  }
  /**
   * Log timing information
   */
  timing(component, message, durationMs, context) {
    this.info(component, `\u23F1 ${message}`, context, { duration: `${durationMs}ms` });
  }
  /**
   * Happy Path Error - logs when the expected "happy path" fails but we have a fallback
   *
   * Semantic meaning: "When the happy path fails, this is an error, but we have a fallback."
   *
   * Use for:
   * ✅ Unexpected null/undefined values that should theoretically never happen
   * ✅ Defensive coding where silent fallback is acceptable
   * ✅ Situations where you want to track unexpected nulls without breaking execution
   *
   * DO NOT use for:
   * ❌ Nullable fields with valid default behavior (use direct || defaults)
   * ❌ Critical validation failures (use logger.warn or throw Error)
   * ❌ Try-catch blocks where error is already logged (redundant)
   *
   * @param component - Component where error occurred
   * @param message - Error message describing what went wrong
   * @param context - Optional context (sessionId, correlationId, etc)
   * @param data - Optional data to include
   * @param fallback - Value to return (defaults to empty string)
   * @returns The fallback value
   */
  happyPathError(component, message, context, data, fallback = "") {
    const stack = new Error().stack || "";
    const stackLines = stack.split("\n");
    const callerLine = stackLines[2] || "";
    const callerMatch = callerLine.match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/);
    const location = callerMatch ? `${callerMatch[1].split("/").pop()}:${callerMatch[2]}` : "unknown";
    const enhancedContext = {
      ...context,
      location
    };
    this.warn(component, `[HAPPY-PATH] ${message}`, enhancedContext, data);
    return fallback;
  }
};
var logger = new Logger();

// src/shared/paths.ts
function getDirname() {
  if (typeof __dirname !== "undefined") {
    return __dirname;
  }
  return dirname2(fileURLToPath(import.meta.url));
}
var _dirname = getDirname();
var DATA_DIR = SettingsDefaultsManager.get("CLAUDE_RECALL_DATA_DIR");
var CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join3(homedir3(), ".claude");
var ARCHIVES_DIR = join3(DATA_DIR, "archives");
var LOGS_DIR = join3(DATA_DIR, "logs");
var TRASH_DIR = join3(DATA_DIR, "trash");
var BACKUPS_DIR = join3(DATA_DIR, "backups");
var MODES_DIR = join3(DATA_DIR, "modes");
var USER_SETTINGS_PATH = join3(DATA_DIR, "settings.json");
var DB_PATH = join3(DATA_DIR, "claude-recall.db");
var VECTOR_DB_DIR = join3(DATA_DIR, "vector-db");
var CLAUDE_SETTINGS_PATH = join3(CLAUDE_CONFIG_DIR, "settings.json");
var CLAUDE_COMMANDS_DIR = join3(CLAUDE_CONFIG_DIR, "commands");
var CLAUDE_MD_PATH = join3(CLAUDE_CONFIG_DIR, "CLAUDE.md");
function ensureDir(dirPath) {
  mkdirSync3(dirPath, { recursive: true });
}

// src/services/sqlite/migrations/runner.ts
var MigrationRunner = class {
  constructor(db) {
    this.db = db;
  }
  /**
   * Run all migrations in order
   * This is the only public method - all migrations are internal
   */
  runAllMigrations() {
    this.initializeSchema();
    this.ensureWorkerPortColumn();
    this.ensurePromptTrackingColumns();
    this.removeSessionSummariesUniqueConstraint();
    this.addObservationHierarchicalFields();
    this.makeObservationsTextNullable();
    this.createUserPromptsTable();
    this.ensureDiscoveryTokensColumn();
    this.createPendingMessagesTable();
    this.renameSessionIdColumns();
    this.repairSessionIdColumnRename();
    this.addFailedAtEpochColumn();
    this.addRawObservationsTable();
  }
  /**
   * Initialize database schema using migrations (migration004)
   * This runs the core SDK tables migration if no tables exist
   */
  initializeSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const appliedVersions = this.db.prepare("SELECT version FROM schema_versions ORDER BY version").all();
    const maxApplied = appliedVersions.length > 0 ? Math.max(...appliedVersions.map((v) => v.version)) : 0;
    if (maxApplied === 0) {
      logger.info("DB", "Initializing fresh database with migration004");
      this.db.run(`
        CREATE TABLE IF NOT EXISTS sdk_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content_session_id TEXT UNIQUE NOT NULL,
          memory_session_id TEXT UNIQUE,
          project TEXT NOT NULL,
          user_prompt TEXT,
          started_at TEXT NOT NULL,
          started_at_epoch INTEGER NOT NULL,
          completed_at TEXT,
          completed_at_epoch INTEGER,
          status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
        );

        CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id);
        CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id);
        CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
        CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);

        CREATE TABLE IF NOT EXISTS observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          text TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery')),
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(memory_session_id);
        CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
        CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
        CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);

        CREATE TABLE IF NOT EXISTS session_summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT UNIQUE NOT NULL,
          project TEXT NOT NULL,
          request TEXT,
          investigated TEXT,
          learned TEXT,
          completed TEXT,
          next_steps TEXT,
          files_read TEXT,
          files_edited TEXT,
          notes TEXT,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
        CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
        CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
      `);
      this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4, (/* @__PURE__ */ new Date()).toISOString());
      logger.info("DB", "Migration004 applied successfully");
    }
  }
  /**
   * Ensure worker_port column exists (migration 5)
   */
  ensureWorkerPortColumn() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5);
    if (applied) return;
    const tableInfo = this.db.query("PRAGMA table_info(sdk_sessions)").all();
    const hasWorkerPort = tableInfo.some((col) => col.name === "worker_port");
    if (!hasWorkerPort) {
      this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER");
      logger.debug("DB", "Added worker_port column to sdk_sessions table");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * Ensure prompt tracking columns exist (migration 6)
   */
  ensurePromptTrackingColumns() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6);
    if (applied) return;
    const sessionsInfo = this.db.query("PRAGMA table_info(sdk_sessions)").all();
    const hasPromptCounter = sessionsInfo.some((col) => col.name === "prompt_counter");
    if (!hasPromptCounter) {
      this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0");
      logger.debug("DB", "Added prompt_counter column to sdk_sessions table");
    }
    const observationsInfo = this.db.query("PRAGMA table_info(observations)").all();
    const obsHasPromptNumber = observationsInfo.some((col) => col.name === "prompt_number");
    if (!obsHasPromptNumber) {
      this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER");
      logger.debug("DB", "Added prompt_number column to observations table");
    }
    const summariesInfo = this.db.query("PRAGMA table_info(session_summaries)").all();
    const sumHasPromptNumber = summariesInfo.some((col) => col.name === "prompt_number");
    if (!sumHasPromptNumber) {
      this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER");
      logger.debug("DB", "Added prompt_number column to session_summaries table");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * Remove UNIQUE constraint from session_summaries.memory_session_id (migration 7)
   */
  removeSessionSummariesUniqueConstraint() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7);
    if (applied) return;
    const summariesIndexes = this.db.query("PRAGMA index_list(session_summaries)").all();
    const hasUniqueConstraint = summariesIndexes.some((idx) => idx.unique === 1);
    if (!hasUniqueConstraint) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Removing UNIQUE constraint from session_summaries.memory_session_id");
    this.db.run("BEGIN TRANSACTION");
    this.db.run(`
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `);
    this.db.run(`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, created_at, created_at_epoch
      FROM session_summaries
    `);
    this.db.run("DROP TABLE session_summaries");
    this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries");
    this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `);
    this.db.run("COMMIT");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "Successfully removed UNIQUE constraint from session_summaries.memory_session_id");
  }
  /**
   * Add hierarchical fields to observations table (migration 8)
   */
  addObservationHierarchicalFields() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8);
    if (applied) return;
    const tableInfo = this.db.query("PRAGMA table_info(observations)").all();
    const hasTitle = tableInfo.some((col) => col.name === "title");
    if (hasTitle) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Adding hierarchical fields to observations table");
    this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "Successfully added hierarchical fields to observations table");
  }
  /**
   * Make observations.text nullable (migration 9)
   * The text field is deprecated in favor of structured fields (title, subtitle, narrative, etc.)
   */
  makeObservationsTextNullable() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9);
    if (applied) return;
    const tableInfo = this.db.query("PRAGMA table_info(observations)").all();
    const textColumn = tableInfo.find((col) => col.name === "text");
    if (!textColumn || textColumn.notnull === 0) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Making observations.text nullable");
    this.db.run("BEGIN TRANSACTION");
    this.db.run(`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `);
    this.db.run(`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             created_at, created_at_epoch
      FROM observations
    `);
    this.db.run("DROP TABLE observations");
    this.db.run("ALTER TABLE observations_new RENAME TO observations");
    this.db.run(`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `);
    this.db.run("COMMIT");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "Successfully made observations.text nullable");
  }
  /**
   * Create user_prompts table with FTS5 support (migration 10)
   */
  createUserPromptsTable() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10);
    if (applied) return;
    const tableInfo = this.db.query("PRAGMA table_info(user_prompts)").all();
    if (tableInfo.length > 0) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Creating user_prompts table with FTS5 support");
    this.db.run("BEGIN TRANSACTION");
    this.db.run(`
      CREATE TABLE user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id);
      CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
      CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
      CREATE INDEX idx_user_prompts_lookup ON user_prompts(content_session_id, prompt_number);
    `);
    this.db.run(`
      CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
        prompt_text,
        content='user_prompts',
        content_rowid='id'
      );
    `);
    this.db.run(`
      CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;

      CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
      END;

      CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;
    `);
    this.db.run("COMMIT");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "Successfully created user_prompts table with FTS5 support");
  }
  /**
   * Ensure discovery_tokens column exists (migration 11)
   * CRITICAL: This migration was incorrectly using version 7 (which was already taken by removeSessionSummariesUniqueConstraint)
   * The duplicate version number may have caused migration tracking issues in some databases
   */
  ensureDiscoveryTokensColumn() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11);
    if (applied) return;
    const observationsInfo = this.db.query("PRAGMA table_info(observations)").all();
    const obsHasDiscoveryTokens = observationsInfo.some((col) => col.name === "discovery_tokens");
    if (!obsHasDiscoveryTokens) {
      this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0");
      logger.debug("DB", "Added discovery_tokens column to observations table");
    }
    const summariesInfo = this.db.query("PRAGMA table_info(session_summaries)").all();
    const sumHasDiscoveryTokens = summariesInfo.some((col) => col.name === "discovery_tokens");
    if (!sumHasDiscoveryTokens) {
      this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0");
      logger.debug("DB", "Added discovery_tokens column to session_summaries table");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * Create pending_messages table for persistent work queue (migration 16)
   * Messages are persisted before processing and deleted after success.
   * Enables recovery from SDK hangs and worker crashes.
   */
  createPendingMessagesTable() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16);
    if (applied) return;
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all();
    if (tables.length > 0) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Creating pending_messages table");
    this.db.run(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL,
        started_processing_at_epoch INTEGER,
        completed_at_epoch INTEGER,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "pending_messages table created successfully");
  }
  /**
   * Rename session ID columns for semantic clarity (migration 17)
   * - claude_session_id -> content_session_id (user's observed session)
   * - sdk_session_id -> memory_session_id (memory agent's session for resume)
   *
   * IDEMPOTENT: Checks each table individually before renaming.
   * This handles databases in any intermediate state (partial migration, fresh install, etc.)
   */
  renameSessionIdColumns() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17);
    if (applied) return;
    logger.debug("DB", "Checking session ID columns for semantic clarity rename");
    let renamesPerformed = 0;
    const safeRenameColumn = (table, oldCol, newCol) => {
      const tableInfo = this.db.query(`PRAGMA table_info(${table})`).all();
      const hasOldCol = tableInfo.some((col) => col.name === oldCol);
      const hasNewCol = tableInfo.some((col) => col.name === newCol);
      if (hasNewCol) {
        return false;
      }
      if (hasOldCol) {
        this.db.run(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
        logger.debug("DB", `Renamed ${table}.${oldCol} to ${newCol}`);
        return true;
      }
      logger.warn("DB", `Column ${oldCol} not found in ${table}, skipping rename`);
      return false;
    };
    if (safeRenameColumn("sdk_sessions", "claude_session_id", "content_session_id")) renamesPerformed++;
    if (safeRenameColumn("sdk_sessions", "sdk_session_id", "memory_session_id")) renamesPerformed++;
    if (safeRenameColumn("pending_messages", "claude_session_id", "content_session_id")) renamesPerformed++;
    if (safeRenameColumn("observations", "sdk_session_id", "memory_session_id")) renamesPerformed++;
    if (safeRenameColumn("session_summaries", "sdk_session_id", "memory_session_id")) renamesPerformed++;
    if (safeRenameColumn("user_prompts", "claude_session_id", "content_session_id")) renamesPerformed++;
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17, (/* @__PURE__ */ new Date()).toISOString());
    if (renamesPerformed > 0) {
      logger.debug("DB", `Successfully renamed ${renamesPerformed} session ID columns`);
    } else {
      logger.debug("DB", "No session ID column renames needed (already up to date)");
    }
  }
  /**
   * Repair session ID column renames (migration 19)
   * DEPRECATED: Migration 17 is now fully idempotent and handles all cases.
   * This migration is kept for backwards compatibility but does nothing.
   */
  repairSessionIdColumnRename() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(19);
    if (applied) return;
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(19, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * Add failed_at_epoch column to pending_messages (migration 20)
   * Used by markSessionMessagesFailed() for error recovery tracking
   */
  addFailedAtEpochColumn() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20);
    if (applied) return;
    const tableInfo = this.db.query("PRAGMA table_info(pending_messages)").all();
    const hasColumn = tableInfo.some((col) => col.name === "failed_at_epoch");
    if (!hasColumn) {
      this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER");
      logger.debug("DB", "Added failed_at_epoch column to pending_messages table");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * Create raw_observations table for direct hook storage (migration 21)
   * Stores raw tool data directly from hooks — no AI processing, no subprocess spawning.
   * FTS5 index on tool_name and tool_input only (tool_response is too large for FTS).
   */
  addRawObservationsTable() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21);
    if (applied) return;
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='raw_observations'").all();
    if (tables.length > 0) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Creating raw_observations table");
    this.db.run("BEGIN TRANSACTION");
    this.db.run(`
      CREATE TABLE raw_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL
      )
    `);
    this.db.run("CREATE INDEX idx_raw_obs_session ON raw_observations(content_session_id)");
    this.db.run("CREATE INDEX idx_raw_obs_project ON raw_observations(project)");
    this.db.run("CREATE INDEX idx_raw_obs_tool ON raw_observations(tool_name)");
    this.db.run("CREATE INDEX idx_raw_obs_created ON raw_observations(created_at_epoch DESC)");
    this.db.run(`
      CREATE VIRTUAL TABLE raw_observations_fts USING fts5(
        tool_name,
        tool_input,
        content='raw_observations',
        content_rowid='id'
      )
    `);
    this.db.run(`
      CREATE TRIGGER raw_obs_ai AFTER INSERT ON raw_observations BEGIN
        INSERT INTO raw_observations_fts(rowid, tool_name, tool_input)
        VALUES (new.id, new.tool_name, new.tool_input);
      END;

      CREATE TRIGGER raw_obs_ad AFTER DELETE ON raw_observations BEGIN
        INSERT INTO raw_observations_fts(raw_observations_fts, rowid, tool_name, tool_input)
        VALUES('delete', old.id, old.tool_name, old.tool_input);
      END;

      CREATE TRIGGER raw_obs_au AFTER UPDATE ON raw_observations BEGIN
        INSERT INTO raw_observations_fts(raw_observations_fts, rowid, tool_name, tool_input)
        VALUES('delete', old.id, old.tool_name, old.tool_input);
        INSERT INTO raw_observations_fts(rowid, tool_name, tool_input)
        VALUES (new.id, new.tool_name, new.tool_input);
      END;
    `);
    this.db.run("COMMIT");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "raw_observations table created successfully");
  }
};

// src/services/sqlite/DirectDB.ts
function openDatabase(dbPath = DB_PATH) {
  if (dbPath !== ":memory:") {
    ensureDir(DATA_DIR);
  }
  const db = new Database(dbPath, { create: true, readwrite: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA temp_store = memory");
  const migrationRunner = new MigrationRunner(db);
  migrationRunner.runAllMigrations();
  return db;
}

// src/utils/project-name.ts
import path from "path";
function getProjectName(cwd) {
  if (!cwd || cwd.trim() === "") {
    logger.warn("PROJECT_NAME", "Empty cwd provided, using fallback", { cwd });
    return "unknown-project";
  }
  const basename3 = path.basename(cwd);
  if (basename3 === "") {
    logger.warn("PROJECT_NAME", "Root directory detected, using fallback", { cwd });
    return "unknown-project";
  }
  return basename3;
}
function getProjectContext(cwd) {
  const primary = getProjectName(cwd);
  return { primary, allProjects: [primary] };
}

// src/cli/handlers/context.ts
var MAX_SUMMARY_CHARS = 8e3;
function buildCompactSummary(db, session) {
  const sid = session.content_session_id;
  const prompts = db.prepare(
    `SELECT prompt_number, prompt_text FROM user_prompts
     WHERE content_session_id = ? ORDER BY prompt_number ASC`
  ).all(sid);
  const observations = db.prepare(
    `SELECT id, content_session_id, tool_name, tool_input, tool_response, prompt_number
     FROM raw_observations
     WHERE content_session_id = ? AND tool_name != '_assistant_responses'
     ORDER BY id ASC`
  ).all(sid);
  const assistantRow = db.prepare(
    `SELECT tool_response FROM raw_observations
     WHERE content_session_id = ? AND tool_name = '_assistant_responses'
     ORDER BY id DESC LIMIT 1`
  ).get(sid);
  let assistantResponses = [];
  if (assistantRow?.tool_response) {
    try {
      assistantResponses = JSON.parse(assistantRow.tool_response);
    } catch {
    }
  }
  const assistantByPrompt = /* @__PURE__ */ new Map();
  for (const r of assistantResponses) {
    assistantByPrompt.set(r.prompt_number, r.text);
  }
  const filesTouched = /* @__PURE__ */ new Set();
  const commandsRun = [];
  for (const o of observations) {
    let input = o.tool_input;
    try {
      input = JSON.parse(input ?? "");
    } catch {
    }
    if (["Read", "Write", "Edit"].includes(o.tool_name) && input?.file_path) {
      filesTouched.add(input.file_path);
    }
    if (o.tool_name === "Bash" && input?.command) {
      const cmd = typeof input.command === "string" ? input.command : JSON.stringify(input.command);
      commandsRun.push(cmd.slice(0, 120));
    }
  }
  const statusLabel = session.status === "active" ? "interrupted" : "completed";
  const lines = [];
  lines.push(`# Previous Session \u2014 ${session.project}`);
  lines.push(`Status: ${statusLabel} | Started: ${session.started_at} | ${session.prompt_counter} prompts, ${observations.length} tool uses`);
  lines.push(`Use MCP tools (search, timeline, get_observations) for full details.
`);
  let used = lines.join("\n").length;
  for (const p of prompts) {
    if (used > MAX_SUMMARY_CHARS - 200) break;
    const promptSnippet = p.prompt_text.length > 300 ? p.prompt_text.slice(0, 300) + "..." : p.prompt_text;
    const pLine = `## Prompt ${p.prompt_number}
> ${promptSnippet.replace(/\n/g, " ")}
`;
    lines.push(pLine);
    used += pLine.length;
    const resp = assistantByPrompt.get(p.prompt_number);
    if (resp && used < MAX_SUMMARY_CHARS - 200) {
      const respSnippet = resp.length > 400 ? resp.slice(0, 400) + "..." : resp;
      const rLine = `**Claude:** ${respSnippet.replace(/\n/g, " ")}
`;
      lines.push(rLine);
      used += rLine.length;
    }
  }
  if (filesTouched.size > 0 && used < MAX_SUMMARY_CHARS - 200) {
    const fileList = [...filesTouched].slice(0, 15);
    lines.push(`
### Files touched (${filesTouched.size}):`);
    for (const f of fileList) {
      const fLine = `- ${f}
`;
      lines.push(fLine);
      used += fLine.length;
      if (used > MAX_SUMMARY_CHARS - 100) break;
    }
    if (filesTouched.size > 15) lines.push(`- ...and ${filesTouched.size - 15} more
`);
  }
  if (commandsRun.length > 0 && used < MAX_SUMMARY_CHARS - 200) {
    const cmds = commandsRun.slice(0, 8);
    lines.push(`
### Commands run (${commandsRun.length}):`);
    for (const c of cmds) {
      const cLine = `- \`${c}\`
`;
      lines.push(cLine);
      used += cLine.length;
      if (used > MAX_SUMMARY_CHARS - 100) break;
    }
  }
  return lines.join("\n").trim();
}
var contextHandler = {
  async execute(input) {
    const cwd = input.cwd ?? process.cwd();
    const context = getProjectContext(cwd);
    const db = openDatabase();
    try {
      const projects = context.allProjects;
      const placeholders = projects.map(() => "?").join(",");
      const sessions = db.prepare(
        `SELECT content_session_id, project, status, prompt_counter, started_at, started_at_epoch
         FROM sdk_sessions
         WHERE project IN (${placeholders})
         ORDER BY started_at_epoch DESC
         LIMIT 5`
      ).all(...projects);
      if (sessions.length === 0) {
        return {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: ""
          }
        };
      }
      const withPrompts = sessions.filter((s) => s.prompt_counter > 0);
      const bestSession = withPrompts.length > 0 ? withPrompts.reduce((a, b) => a.prompt_counter >= b.prompt_counter ? a : b) : sessions[0];
      const additionalContext = bestSession.prompt_counter > 0 ? buildCompactSummary(db, bestSession) : "";
      logger.debug("HOOK", "Context generated", {
        sessions: sessions.length,
        contextLength: additionalContext.length
      });
      return {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext
        }
      };
    } finally {
      db.close();
    }
  }
};

// src/cli/handlers/session-init.ts
var sessionInitHandler = {
  async execute(input) {
    const { sessionId, cwd, prompt } = input;
    if (!prompt) {
      throw new Error("sessionInitHandler requires prompt");
    }
    const project = getProjectName(cwd);
    const now = /* @__PURE__ */ new Date();
    const nowIso = now.toISOString();
    const nowEpoch = Math.floor(now.getTime() / 1e3);
    const db = openDatabase();
    try {
      const initSession = db.transaction(() => {
        db.run(
          `INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status, prompt_counter)
           VALUES (?, ?, ?, ?, 'active', 0)`,
          [sessionId, project, nowIso, nowEpoch]
        );
        db.run(
          "UPDATE sdk_sessions SET prompt_counter = prompt_counter + 1 WHERE content_session_id = ?",
          [sessionId]
        );
        const session = db.prepare(
          "SELECT id, prompt_counter FROM sdk_sessions WHERE content_session_id = ?"
        ).get(sessionId);
        const promptNumber = session.prompt_counter;
        db.run(
          `INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
           VALUES (?, ?, ?, ?, ?)`,
          [sessionId, promptNumber, prompt, nowIso, nowEpoch]
        );
        return { sessionDbId: session.id, promptNumber };
      });
      const result = initSession();
      logger.debug("HOOK", `session-init: prompt #${result.promptNumber} stored`, {
        sessionId: result.sessionDbId
      });
    } finally {
      db.close();
    }
    return { continue: true, suppressOutput: true };
  }
};

// src/cli/handlers/observation.ts
import { readFileSync as readFileSync3 } from "fs";
var MAX_RESPONSE_BYTES = 1e4;
var MAX_INPUT_BYTES = 1e4;
var MAX_DB_PAGES = 2621440;
var CLEANUP_PROBABILITY = 0.01;
var CLEANUP_BATCH_PERCENT = 0.1;
var TRANSCRIPT_CAPTURE_INTERVAL = 600;
var MAX_ASSISTANT_RESPONSE_CHARS = 1e4;
function truncateStr(s, maxLen) {
  if (s == null) return null;
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...[truncated at " + maxLen + " chars]";
}
function stringify(val) {
  if (val == null) return null;
  if (typeof val === "string") return val;
  return JSON.stringify(val);
}
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
  }
  return "";
}
function captureTranscript(db, sessionId, project, cwd, transcriptPath, nowEpoch) {
  let data;
  try {
    data = readFileSync3(transcriptPath, "utf-8");
  } catch {
    return;
  }
  const lines = data.split("\n").filter((l) => l.trim());
  const responses = [];
  let promptNumber = 0;
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      const role = msg.role ?? msg.message?.role;
      if (role === "user") promptNumber++;
      if (role === "assistant") {
        const content = msg.content ?? msg.message?.content;
        const text = extractText(content);
        if (text.trim()) {
          responses.push({
            prompt_number: promptNumber,
            text: text.length > MAX_ASSISTANT_RESPONSE_CHARS ? text.slice(0, MAX_ASSISTANT_RESPONSE_CHARS) + "...[truncated]" : text
          });
        }
      }
    } catch {
    }
  }
  if (responses.length === 0) return;
  const responsesJson = JSON.stringify(responses);
  const capped = responsesJson.length > 5e4 ? responsesJson.slice(0, 5e4) + "...[truncated]" : responsesJson;
  db.run(
    `DELETE FROM raw_observations WHERE content_session_id = ? AND tool_name = '_assistant_responses'`,
    [sessionId]
  );
  db.run(
    `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch)
     VALUES (?, ?, '_assistant_responses', NULL, ?, ?, ?, ?, ?)`,
    [sessionId, project, capped, cwd, promptNumber, (/* @__PURE__ */ new Date()).toISOString(), nowEpoch]
  );
  logger.debug("HOOK", `Captured ${responses.length} assistant responses from transcript`);
}
var observationHandler = {
  async execute(input) {
    const { sessionId, cwd, toolName, toolInput, toolResponse, transcriptPath } = input;
    if (!toolName) {
      throw new Error("observationHandler requires toolName");
    }
    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }
    const project = getProjectName(cwd);
    const now = /* @__PURE__ */ new Date();
    const nowEpoch = Math.floor(now.getTime() / 1e3);
    const db = openDatabase();
    try {
      db.run(
        `INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status)
         VALUES (?, ?, ?, ?, 'active')`,
        [sessionId, project, now.toISOString(), nowEpoch]
      );
      const session = db.prepare(
        "SELECT prompt_counter FROM sdk_sessions WHERE content_session_id = ?"
      ).get(sessionId);
      const promptNumber = session?.prompt_counter ?? 0;
      const inputStr = truncateStr(stringify(toolInput), MAX_INPUT_BYTES);
      const responseStr = truncateStr(stringify(toolResponse), MAX_RESPONSE_BYTES);
      db.run(
        `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, project, toolName, inputStr, responseStr, cwd, promptNumber, now.toISOString(), nowEpoch]
      );
      if (transcriptPath) {
        const lastCapture = db.prepare(
          `SELECT created_at_epoch FROM raw_observations
           WHERE content_session_id = ? AND tool_name = '_assistant_responses'
           ORDER BY id DESC LIMIT 1`
        ).get(sessionId);
        const sinceLastCapture = lastCapture ? nowEpoch - lastCapture.created_at_epoch : Infinity;
        if (sinceLastCapture >= TRANSCRIPT_CAPTURE_INTERVAL) {
          captureTranscript(db, sessionId, project, cwd, transcriptPath, nowEpoch);
        }
      }
      if (Math.random() < CLEANUP_PROBABILITY) {
        const pageCount = db.prepare("PRAGMA page_count").get()?.page_count ?? 0;
        if (pageCount > MAX_DB_PAGES) {
          const totalRows = db.prepare("SELECT COUNT(*) as cnt FROM raw_observations").get()?.cnt ?? 0;
          const deleteCount = Math.max(100, Math.floor(totalRows * CLEANUP_BATCH_PERCENT));
          const deleted = db.run(
            `DELETE FROM raw_observations WHERE id IN (
              SELECT id FROM raw_observations ORDER BY created_at_epoch ASC LIMIT ?
            )`,
            [deleteCount]
          );
          if (deleted.changes > 0) {
            logger.info("HOOK", `Size cleanup: deleted ${deleted.changes} oldest observations (DB was ${Math.round(pageCount * 4096 / 1024 / 1024)}MB, limit 10GB)`);
          }
        }
      }
      logger.debug("HOOK", "Raw observation stored", { toolName });
    } finally {
      db.close();
    }
    return { continue: true, suppressOutput: true };
  }
};

// src/cli/handlers/summarize.ts
import { readFileSync as readFileSync4 } from "fs";
var MAX_RESPONSE_CHARS = 1e4;
function extractText2(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
  }
  return "";
}
var summarizeHandler = {
  async execute(input) {
    const { sessionId, cwd, transcriptPath } = input;
    if (!transcriptPath || !sessionId) {
      return { continue: true, suppressOutput: true };
    }
    let transcriptData;
    try {
      transcriptData = readFileSync4(transcriptPath, "utf-8");
    } catch (err) {
      logger.debug("HOOK", `Could not read transcript: ${err}`);
      return { continue: true, suppressOutput: true };
    }
    const project = getProjectName(cwd);
    const now = /* @__PURE__ */ new Date();
    const nowEpoch = Math.floor(now.getTime() / 1e3);
    const lines = transcriptData.split("\n").filter((l) => l.trim());
    const assistantResponses = [];
    let promptNumber = 0;
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        const role = msg.role ?? msg.message?.role;
        if (role === "user") {
          promptNumber++;
        }
        if (role === "assistant") {
          const content = msg.content ?? msg.message?.content;
          const text = extractText2(content);
          if (text.trim()) {
            assistantResponses.push(JSON.stringify({
              prompt_number: promptNumber,
              text: text.length > MAX_RESPONSE_CHARS ? text.slice(0, MAX_RESPONSE_CHARS) + "...[truncated]" : text
            }));
          }
        }
      } catch {
      }
    }
    if (assistantResponses.length === 0) {
      return { continue: true, suppressOutput: true };
    }
    const db = openDatabase();
    try {
      db.run(
        `INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status)
         VALUES (?, ?, ?, ?, 'active')`,
        [sessionId, project, now.toISOString(), nowEpoch]
      );
      const responsesJson = JSON.stringify(assistantResponses.map((r) => JSON.parse(r)));
      const capped = responsesJson.length > 5e4 ? responsesJson.slice(0, 5e4) + "...[truncated]" : responsesJson;
      db.run(
        `DELETE FROM raw_observations WHERE content_session_id = ? AND tool_name = '_assistant_responses'`,
        [sessionId]
      );
      db.run(
        `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch)
         VALUES (?, ?, '_assistant_responses', NULL, ?, ?, ?, ?, ?)`,
        [sessionId, project, capped, cwd, promptNumber, now.toISOString(), nowEpoch]
      );
      logger.debug("HOOK", `Stored ${assistantResponses.length} assistant responses from transcript`);
    } finally {
      db.close();
    }
    return { continue: true, suppressOutput: true };
  }
};

// src/cli/handlers/user-message.ts
import { basename as basename2 } from "path";

// src/shared/worker-utils.ts
import path2 from "path";
import { homedir as homedir4 } from "os";
import { readFileSync as readFileSync5 } from "fs";

// src/shared/hook-constants.ts
var HOOK_TIMEOUTS = {
  DEFAULT: 3e5,
  // Standard HTTP timeout (5 min for slow systems)
  HEALTH_CHECK: 3e4,
  // Worker health check (30s for slow systems)
  WORKER_STARTUP_WAIT: 1e3,
  WORKER_STARTUP_RETRIES: 300,
  PRE_RESTART_SETTLE_DELAY: 2e3,
  // Give files time to sync before restart
  POWERSHELL_COMMAND: 1e4,
  // PowerShell process enumeration (10s - typically completes in <1s)
  WINDOWS_MULTIPLIER: 1.5
  // Platform-specific adjustment
};
var HOOK_EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  /** Blocking error - for SessionStart, shows stderr to user only */
  BLOCKING_ERROR: 2
};
function getTimeout(baseTimeout) {
  return process.platform === "win32" ? Math.round(baseTimeout * HOOK_TIMEOUTS.WINDOWS_MULTIPLIER) : baseTimeout;
}

// src/utils/error-messages.ts
function getWorkerRestartInstructions(options = {}) {
  const {
    port,
    includeSkillFallback = false,
    customPrefix,
    actualError
  } = options;
  const prefix = customPrefix || "Worker service connection failed.";
  const portInfo = port ? ` (port ${port})` : "";
  let message = `${prefix}${portInfo}

`;
  message += `To restart the worker:
`;
  message += `1. Exit Claude Code completely
`;
  message += `2. Run: npm run worker:restart
`;
  message += `3. Restart Claude Code`;
  if (includeSkillFallback) {
    message += `

If that doesn't work, try: /troubleshoot`;
  }
  if (actualError) {
    message = `Worker Error: ${actualError}

${message}`;
  }
  return message;
}

// src/shared/worker-utils.ts
var MARKETPLACE_ROOT = path2.join(homedir4(), ".claude", "plugins", "marketplaces", "askqai");
var HEALTH_CHECK_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.HEALTH_CHECK);
var cachedPort = null;
function getWorkerPort() {
  if (cachedPort !== null) {
    return cachedPort;
  }
  const settingsPath = path2.join(SettingsDefaultsManager.get("CLAUDE_RECALL_DATA_DIR"), "settings.json");
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedPort = parseInt(settings.CLAUDE_RECALL_WORKER_PORT, 10);
  return cachedPort;
}
async function isWorkerHealthy() {
  const port = getWorkerPort();
  const response = await fetch(`http://127.0.0.1:${port}/api/readiness`);
  return response.ok;
}
function getPluginVersion() {
  const packageJsonPath = path2.join(MARKETPLACE_ROOT, "package.json");
  const packageJson = JSON.parse(readFileSync5(packageJsonPath, "utf-8"));
  return packageJson.version;
}
async function getWorkerVersion() {
  const port = getWorkerPort();
  const response = await fetch(`http://127.0.0.1:${port}/api/version`);
  if (!response.ok) {
    throw new Error(`Failed to get worker version: ${response.status}`);
  }
  const data = await response.json();
  return data.version;
}
async function checkWorkerVersion() {
  const pluginVersion = getPluginVersion();
  const workerVersion = await getWorkerVersion();
  if (pluginVersion !== workerVersion) {
    logger.debug("SYSTEM", "Version check", {
      pluginVersion,
      workerVersion,
      note: "Mismatch will be auto-restarted by worker-service start command"
    });
  }
}
async function ensureWorkerRunning() {
  const maxRetries = 75;
  const pollInterval = 200;
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (await isWorkerHealthy()) {
        await checkWorkerVersion();
        return;
      }
    } catch (e) {
      logger.debug("SYSTEM", "Worker health check failed, will retry", {
        attempt: i + 1,
        maxRetries,
        error: e instanceof Error ? e.message : String(e)
      });
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  throw new Error(getWorkerRestartInstructions({
    port: getWorkerPort(),
    customPrefix: "Worker did not become ready within 15 seconds."
  }));
}

// src/cli/handlers/user-message.ts
var userMessageHandler = {
  async execute(input) {
    await ensureWorkerRunning();
    const port = getWorkerPort();
    const project = basename2(input.cwd ?? process.cwd());
    const response = await fetch(
      `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}&colors=true`,
      { method: "GET" }
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch context: ${response.status}`);
    }
    const output = await response.text();
    console.error(
      "\n\n" + String.fromCodePoint(128221) + " Claude-Recall Context Loaded\n   " + String.fromCodePoint(8505, 65039) + "  Note: This appears as stderr but is informational only\n\n" + output + "\n\n" + String.fromCodePoint(128161) + " New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.\n\n" + String.fromCodePoint(128172) + ` Community https://discord.gg/J4wttp9vDu
` + String.fromCodePoint(128250) + ` Watch live in browser http://localhost:${port}/
`
    );
    return { exitCode: HOOK_EXIT_CODES.USER_MESSAGE_ONLY };
  }
};

// src/cli/handlers/file-edit.ts
var fileEditHandler = {
  async execute(input) {
    await ensureWorkerRunning();
    const { sessionId, cwd, filePath, edits } = input;
    if (!filePath) {
      throw new Error("fileEditHandler requires filePath");
    }
    const port = getWorkerPort();
    logger.dataIn("HOOK", `FileEdit: ${filePath}`, {
      workerPort: port,
      editCount: edits?.length ?? 0
    });
    if (!cwd) {
      throw new Error(`Missing cwd in FileEdit hook input for session ${sessionId}, file ${filePath}`);
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId: sessionId,
        tool_name: "write_file",
        tool_input: { filePath, edits },
        tool_response: { success: true },
        cwd
      })
      // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
    });
    if (!response.ok) {
      throw new Error(`File edit observation storage failed: ${response.status}`);
    }
    logger.debug("HOOK", "File edit observation sent successfully", { filePath });
    return { continue: true, suppressOutput: true };
  }
};

// src/cli/handlers/session-end.ts
var sessionEndHandler = {
  async execute(input) {
    const { sessionId } = input;
    const now = /* @__PURE__ */ new Date();
    const db = openDatabase();
    try {
      db.run(
        `UPDATE sdk_sessions SET status = 'completed', completed_at = ?, completed_at_epoch = ?
         WHERE content_session_id = ? AND status = 'active'`,
        [now.toISOString(), Math.floor(now.getTime() / 1e3), sessionId]
      );
      logger.debug("HOOK", "SessionEnd: Session marked completed", { contentSessionId: sessionId });
    } catch (error) {
      logger.warn("HOOK", "SessionEnd: Failed to mark session completed", {
        contentSessionId: sessionId
      });
    } finally {
      db.close();
    }
    return { continue: true, suppressOutput: true };
  }
};

// src/cli/handlers/index.ts
var handlers = {
  "context": contextHandler,
  "session-init": sessionInitHandler,
  "observation": observationHandler,
  "summarize": summarizeHandler,
  "session-end": sessionEndHandler,
  "user-message": userMessageHandler,
  "file-edit": fileEditHandler
};
function getEventHandler(eventType) {
  const handler = handlers[eventType];
  if (!handler) {
    throw new Error(`Unknown event type: ${eventType}`);
  }
  return handler;
}

// src/cli/hook-command.ts
async function hookCommand(platform2, event2) {
  try {
    const adapter = getPlatformAdapter(platform2);
    const handler = getEventHandler(event2);
    const rawInput = await readJsonFromStdin();
    const input = adapter.normalizeInput(rawInput);
    input.platform = platform2;
    const result = await handler.execute(input);
    const output = adapter.formatOutput(result);
    console.log(JSON.stringify(output));
    process.exit(result.exitCode ?? HOOK_EXIT_CODES.SUCCESS);
  } catch (error) {
    console.error(`Hook error: ${error}`);
    process.exit(HOOK_EXIT_CODES.BLOCKING_ERROR);
  }
}

// src/cli/hook-entry.ts
var platform = process.argv[2];
var event = process.argv[3];
if (!platform || !event) {
  console.error("Usage: hook-command <platform> <event>");
  console.error("Platforms: claude-code, cursor, raw");
  console.error("Events: context, session-init, observation, summarize, session-end, user-message");
  process.exit(1);
}
hookCommand(platform, event);
