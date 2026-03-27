/**
 * Privacy Module
 *
 * Detects private prompts, sensitive patterns (API keys, tokens, passwords),
 * and provides redaction utilities. Used by session-init and observation handlers.
 */

/** Tags that suppress recall for the current prompt and subsequent tool uses */
const PRIVATE_TAG_PATTERN = /<(?:private|no-recall)>/i;

/** Sensitive patterns to auto-redact from stored content */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?key)\s*[:=]\s*['"]?[a-zA-Z0-9_\-]{20,}/gi, label: 'API_KEY' },
  { pattern: /Bearer\s+[a-zA-Z0-9_\-\.]{20,}/g, label: 'BEARER_TOKEN' },
  { pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/g, label: 'AWS_KEY' },
  { pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g, label: 'PRIVATE_KEY' },
  { pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi, label: 'PASSWORD' },
  { pattern: /ghp_[a-zA-Z0-9]{36,}/g, label: 'GITHUB_TOKEN' },
  { pattern: /sk-[a-zA-Z0-9]{32,}/g, label: 'OPENAI_KEY' },
  { pattern: /xox[bpras]-[a-zA-Z0-9\-]{10,}/g, label: 'SLACK_TOKEN' },
];

/**
 * Check if a user prompt contains privacy suppression tags.
 */
export function isPrivatePrompt(prompt: string): boolean {
  return PRIVATE_TAG_PATTERN.test(prompt);
}

/**
 * Check if text contains sensitive patterns (API keys, tokens, etc.).
 */
export function containsSensitivePatterns(text: string): boolean {
  return SENSITIVE_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0; // reset regex state
    return pattern.test(text);
  });
}

/**
 * Redact sensitive content from text, replacing matches with [REDACTED:label].
 * Returns the original text if no sensitive patterns are found.
 */
export function redactSensitiveContent(text: string): string {
  let redacted = text;
  for (const { pattern, label } of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, `[REDACTED:${label}]`);
  }
  return redacted;
}
