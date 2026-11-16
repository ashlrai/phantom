#!/usr/bin/env node
/* global process, console */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// These files define the native inventory or schemas included in tools/list.
export const MCP_INVENTORY_PATHS = Object.freeze([
  'src/core/mcp-native.ts',
  'src/core/desktop/operator-mcp.ts',
  'src/core/teams/tools.ts',
  'src/core/proactive/schema.ts',
  'src/core/mcp-gateway.ts',
  'src/core/mcp-registry.ts',
  'src/core/tools-registry.ts',
  'src/cli/mcp.ts',
  'test/mcp-output-efficiency.test.ts',
  'test/__snapshots__/mcp-output-efficiency.test.ts.snap',
]);
const paths = new Set(MCP_INVENTORY_PATHS);
export function selectMcpOutputTest(changedPaths) {
  return changedPaths.some(path => paths.has(path));
}
export function selectMcpDiff({ base, head, cwd }) {
  if (!/^[0-9a-f]{40}$/.test(base ?? '') || !/^[0-9a-f]{40}$/.test(head ?? '')) throw new Error('base and head must be exact commit SHAs');
  const git = args => execFileSync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 }).toString('utf8');
  if (git(['rev-parse', 'HEAD']).trim() !== head) throw new Error('checkout does not match head');
  const mergeBase = git(['merge-base', base, head]).trim();
  const changed = git(['diff', '--name-only', '-z', '--no-renames', mergeBase, head]);
  if (changed && !changed.endsWith('\0')) throw new Error('incomplete path list');
  return selectMcpOutputTest(changed ? changed.slice(0, -1).split('\0') : []);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const selected = selectMcpDiff({ base: process.env.ASHLR_CI_BASE_SHA, head: process.env.ASHLR_CI_HEAD_SHA, cwd: process.cwd() });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mcp_output=${selected}\n`);
    console.log(`mcp-output-efficiency: ${selected ? 'selected' : 'not selected'}`);
  } catch (error) {
    console.error(`MCP test selection failed: ${error.message}`);
    process.exitCode = 1;
  }
}
