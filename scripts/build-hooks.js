#!/usr/bin/env node
/**
 * Build script for claude-recall
 *
 * Compiles TypeScript source to JavaScript bundles for:
 * - Hook command (plugin/scripts/hook-command.js)
 * - MCP server (plugin/scripts/mcp-server.cjs)
 */

import { build } from 'esbuild';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const packageJson = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
const packageVersion = packageJson.version;
console.log(`Package version: ${packageVersion}`);

// Common build options
const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  external: [
    'better-sqlite3',
    'bun:sqlite',
  ],
};

async function buildMCPServer() {
  console.log('Building mcp-server.cjs...');
  await build({
    ...commonOptions,
    entryPoints: [path.join(rootDir, 'src/servers/mcp-server.ts')],
    outfile: path.join(rootDir, 'plugin/scripts/mcp-server.cjs'),
    banner: { js: '#!/usr/bin/env node' },
  });
  console.log('  ✓ mcp-server.cjs');
}

async function buildHookCommand() {
  console.log('Building hook-command.js (ESM)...');
  await build({
    ...commonOptions,
    format: 'esm',
    entryPoints: [path.join(rootDir, 'src/cli/hook-entry.ts')],
    outfile: path.join(rootDir, 'plugin/scripts/hook-command.js'),
  });
  console.log('  ✓ hook-command.js');
}

async function main() {
  console.log('');
  console.log('=================================');
  console.log('  claude-recall Build');
  console.log('=================================');
  console.log('');

  const startTime = Date.now();

  try {
    await Promise.all([
      buildMCPServer(),
      buildHookCommand(),
    ]);

    const elapsed = Date.now() - startTime;
    console.log('');
    console.log(`Build complete in ${elapsed}ms`);
    console.log('');
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}

main();
