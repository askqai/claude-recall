/**
 * SettingsDefaultsManager
 *
 * Single source of truth for all default configuration values.
 * Provides methods to get defaults with optional environment variable overrides.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { DEFAULT_OBSERVATION_TYPES_STRING, DEFAULT_OBSERVATION_CONCEPTS_STRING } from '../constants/observation-metadata.js';
// NOTE: Do NOT import logger here - it creates a circular dependency
// logger.ts depends on SettingsDefaultsManager for its initialization

export interface SettingsDefaults {
  CLAUDE_RECALL_MODEL: string;
  CLAUDE_RECALL_CONTEXT_OBSERVATIONS: string;
  CLAUDE_RECALL_WORKER_PORT: string;
  CLAUDE_RECALL_WORKER_HOST: string;
  CLAUDE_RECALL_SKIP_TOOLS: string;
  // AI Provider Configuration
  CLAUDE_RECALL_PROVIDER: string;  // 'claude' | 'gemini' | 'openrouter'
  CLAUDE_RECALL_GEMINI_API_KEY: string;
  CLAUDE_RECALL_GEMINI_MODEL: string;  // 'gemini-2.5-flash-lite' | 'gemini-2.5-flash' | 'gemini-3-flash'
  CLAUDE_RECALL_GEMINI_RATE_LIMITING_ENABLED: string;  // 'true' | 'false' - enable rate limiting for free tier
  CLAUDE_RECALL_OPENROUTER_API_KEY: string;
  CLAUDE_RECALL_OPENROUTER_MODEL: string;
  CLAUDE_RECALL_OPENROUTER_SITE_URL: string;
  CLAUDE_RECALL_OPENROUTER_APP_NAME: string;
  CLAUDE_RECALL_OPENROUTER_MAX_CONTEXT_MESSAGES: string;
  CLAUDE_RECALL_OPENROUTER_MAX_TOKENS: string;
  // System Configuration
  CLAUDE_RECALL_DATA_DIR: string;
  CLAUDE_RECALL_LOG_LEVEL: string;
  CLAUDE_RECALL_PYTHON_VERSION: string;
  CLAUDE_CODE_PATH: string;
  CLAUDE_RECALL_MODE: string;
  // Token Economics
  CLAUDE_RECALL_CONTEXT_SHOW_READ_TOKENS: string;
  CLAUDE_RECALL_CONTEXT_SHOW_WORK_TOKENS: string;
  CLAUDE_RECALL_CONTEXT_SHOW_SAVINGS_AMOUNT: string;
  CLAUDE_RECALL_CONTEXT_SHOW_SAVINGS_PERCENT: string;
  // Observation Filtering
  CLAUDE_RECALL_CONTEXT_OBSERVATION_TYPES: string;
  CLAUDE_RECALL_CONTEXT_OBSERVATION_CONCEPTS: string;
  // Display Configuration
  CLAUDE_RECALL_CONTEXT_FULL_COUNT: string;
  CLAUDE_RECALL_CONTEXT_FULL_FIELD: string;
  CLAUDE_RECALL_CONTEXT_SESSION_COUNT: string;
  // Feature Toggles
  CLAUDE_RECALL_CONTEXT_SHOW_LAST_SUMMARY: string;
  CLAUDE_RECALL_CONTEXT_SHOW_LAST_MESSAGE: string;
  // Privacy
  CLAUDE_RECALL_REDACT_SECRETS: string;
  // Storage Limits
  CLAUDE_RECALL_MAX_DB_SIZE_GB: string;
}

export class SettingsDefaultsManager {
  /**
   * Default values for all settings
   */
  private static readonly DEFAULTS: SettingsDefaults = {
    CLAUDE_RECALL_MODEL: 'claude-sonnet-4-5',
    CLAUDE_RECALL_CONTEXT_OBSERVATIONS: '50',
    CLAUDE_RECALL_WORKER_PORT: '37777',
    CLAUDE_RECALL_WORKER_HOST: '127.0.0.1',
    CLAUDE_RECALL_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion',
    // AI Provider Configuration
    CLAUDE_RECALL_PROVIDER: 'claude',  // Default to Claude
    CLAUDE_RECALL_GEMINI_API_KEY: '',  // Empty by default, can be set via UI or env
    CLAUDE_RECALL_GEMINI_MODEL: 'gemini-2.5-flash-lite',  // Default Gemini model (highest free tier RPM)
    CLAUDE_RECALL_GEMINI_RATE_LIMITING_ENABLED: 'true',  // Rate limiting ON by default for free tier users
    CLAUDE_RECALL_OPENROUTER_API_KEY: '',  // Empty by default, can be set via UI or env
    CLAUDE_RECALL_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',  // Default OpenRouter model (free tier)
    CLAUDE_RECALL_OPENROUTER_SITE_URL: '',  // Optional: for OpenRouter analytics
    CLAUDE_RECALL_OPENROUTER_APP_NAME: 'claude-recall',  // App name for OpenRouter analytics
    CLAUDE_RECALL_OPENROUTER_MAX_CONTEXT_MESSAGES: '20',  // Max messages in context window
    CLAUDE_RECALL_OPENROUTER_MAX_TOKENS: '100000',  // Max estimated tokens (~100k safety limit)
    // System Configuration
    CLAUDE_RECALL_DATA_DIR: join(homedir(), '.claude-recall'),
    CLAUDE_RECALL_LOG_LEVEL: 'INFO',
    CLAUDE_RECALL_PYTHON_VERSION: '3.13',
    CLAUDE_CODE_PATH: '', // Empty means auto-detect via 'which claude'
    CLAUDE_RECALL_MODE: 'code', // Default mode profile
    // Token Economics
    CLAUDE_RECALL_CONTEXT_SHOW_READ_TOKENS: 'true',
    CLAUDE_RECALL_CONTEXT_SHOW_WORK_TOKENS: 'true',
    CLAUDE_RECALL_CONTEXT_SHOW_SAVINGS_AMOUNT: 'true',
    CLAUDE_RECALL_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',
    // Observation Filtering
    CLAUDE_RECALL_CONTEXT_OBSERVATION_TYPES: DEFAULT_OBSERVATION_TYPES_STRING,
    CLAUDE_RECALL_CONTEXT_OBSERVATION_CONCEPTS: DEFAULT_OBSERVATION_CONCEPTS_STRING,
    // Display Configuration
    CLAUDE_RECALL_CONTEXT_FULL_COUNT: '5',
    CLAUDE_RECALL_CONTEXT_FULL_FIELD: 'narrative',
    CLAUDE_RECALL_CONTEXT_SESSION_COUNT: '10',
    // Feature Toggles
    CLAUDE_RECALL_CONTEXT_SHOW_LAST_SUMMARY: 'true',
    CLAUDE_RECALL_CONTEXT_SHOW_LAST_MESSAGE: 'false',
    // Privacy
    CLAUDE_RECALL_REDACT_SECRETS: 'true',
    // Storage Limits
    CLAUDE_RECALL_MAX_DB_SIZE_GB: '10',
  };

  /**
   * Get all defaults as an object
   */
  static getAllDefaults(): SettingsDefaults {
    return { ...this.DEFAULTS };
  }

  /**
   * Get a default value from defaults (no environment variable override)
   */
  static get(key: keyof SettingsDefaults): string {
    return this.DEFAULTS[key];
  }

  /**
   * Get an integer default value
   */
  static getInt(key: keyof SettingsDefaults): number {
    const value = this.get(key);
    return parseInt(value, 10);
  }

  /**
   * Get a boolean default value
   */
  static getBool(key: keyof SettingsDefaults): boolean {
    const value = this.get(key);
    return value === 'true';
  }

  /**
   * Load settings from file with fallback to defaults
   * Returns merged settings with defaults as fallback
   * Handles all errors (missing file, corrupted JSON, permissions) by returning defaults
   */
  static loadFromFile(settingsPath: string): SettingsDefaults {
    try {
      if (!existsSync(settingsPath)) {
        const defaults = this.getAllDefaults();
        try {
          const dir = dirname(settingsPath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
          // Use console instead of logger to avoid circular dependency
          console.log('[SETTINGS] Created settings file with defaults:', settingsPath);
        } catch (error) {
          console.warn('[SETTINGS] Failed to create settings file, using in-memory defaults:', settingsPath, error);
        }
        return defaults;
      }

      const settingsData = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsData);

      // MIGRATION: Handle old nested schema { env: {...} }
      let flatSettings = settings;
      if (settings.env && typeof settings.env === 'object') {
        // Migrate from nested to flat schema
        flatSettings = settings.env;

        // Auto-migrate the file to flat schema
        try {
          writeFileSync(settingsPath, JSON.stringify(flatSettings, null, 2), 'utf-8');
          console.log('[SETTINGS] Migrated settings file from nested to flat schema:', settingsPath);
        } catch (error) {
          console.warn('[SETTINGS] Failed to auto-migrate settings file:', settingsPath, error);
          // Continue with in-memory migration even if write fails
        }
      }

      // Merge file settings with defaults (flat schema)
      const result: SettingsDefaults = { ...this.DEFAULTS };
      for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
        if (flatSettings[key] !== undefined) {
          result[key] = flatSettings[key];
        }
      }

      return result;
    } catch (error) {
      console.warn('[SETTINGS] Failed to load settings, using defaults:', settingsPath, error);
      return this.getAllDefaults();
    }
  }
}
