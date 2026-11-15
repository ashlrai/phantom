/* global process, console */
// Advisory until docs/strategy/ci-rightsizing.patch receives Security review.
// Standalone: the workflow must load this file from its trusted base commit.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = /^[a-f0-9]{40}$/;
const git = (cwd, args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
});

export function ownerPatterns(text) {
  const patterns = [];
  for (const line of text.split('\n')) {
    const fields = line.replace(/\s+#.*$/, '').trim().split(/\s+/);
    const [pattern, ...owners] = fields;
    if (!pattern || pattern.startsWith('#')) continue;
    // Support the generated map's grammar only. Unknown syntax cannot lower risk.
    if (!/^(?:\/|\*\*\/)[\w.*?/-]+$/.test(pattern) || !owners.length ||
        owners.some((owner) => !/^@[\w-]+(?:\/[\w-]+)?$/.test(owner))) {
      throw new Error('Unsupported CODEOWNERS rule');
    }
    let expression = '';
    const rooted = pattern.replace(/^\//, '');
    for (let i = 0; i < rooted.length; i++) {
      if (rooted.slice(i, i + 3) === '**/') { expression += '(?:.*/)?'; i += 2; }
      else if (rooted.slice(i, i + 2) === '**') { expression += '.*'; i++; }
      else if (rooted[i] === '*') expression += '[^/]*';
      else if (rooted[i] === '?') expression += '[^/]';
      else expression += rooted[i].replace(/[.]/g, '\\$&');
    }
    // Union of owned rules; never use a later rule to clear Tier-1 protection.
    patterns.push(new RegExp(`^${expression}${rooted.endsWith('/') ? '.*' : '(?:/.*)?'}$`, 'i'));
  }
  if (!patterns.length) throw new Error('Empty CODEOWNERS map');
  return patterns;
}

export function classifyRisk({ cwd, eventName, base, head }) {
  if (!['pull_request', 'merge_group'].includes(eventName)) return 'full';
  if (!sha.test(base ?? '') || !sha.test(head ?? '')) throw new Error('Exact base/head SHAs required');
  if (git(cwd, ['rev-parse', 'HEAD']).trim() !== head) throw new Error('Candidate checkout mismatch');
  const start = git(cwd, ['merge-base', base, head]).trim();
  if (eventName === 'merge_group' && start !== base) throw new Error('Merge group base is not an ancestor');
  const owned = ownerPatterns(git(cwd, ['show', `${base}:.github/CODEOWNERS`]));
  // --no-renames exposes both the removed protected path and the destination.
  const raw = git(cwd, ['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', start, head]);
  if (!raw) return 'full';
  const fields = raw.split('\0');
  if (fields.pop() !== '' || fields.length % 2) throw new Error('Incomplete Git diff');
  for (let i = 0; i < fields.length; i += 2) {
    const modes = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ [AMDT]$/.exec(fields[i]);
    const path = fields[i + 1];
    if (!modes || !path || path.includes('\\') || [...path].some(c => c.charCodeAt(0) < 32)) {
      throw new Error('Unsupported Git diff');
    }
    if (modes.slice(1).some((mode) => !['000000', '100644'].includes(mode))) return 'full';
    if (owned.some((pattern) => pattern.test(path))) return 'full';
    // Stage one: ordinary source needs full CI until trusted receipts are wired.
    if (!/^(?:[^/]+\.md|docs\/.+\.md|test\/.+\.test\.ts)$/.test(path)) return 'full';
  }
  return 'smoke';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const risk = classifyRisk({ cwd: process.cwd(), eventName: process.env.GITHUB_EVENT_NAME,
      base: process.env.ASHLR_CI_BASE_SHA, head: process.env.ASHLR_CI_HEAD_SHA });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `risk=${risk}\n`);
    console.log(`CI risk: ${risk}`);
  } catch (error) {
    console.error(`CI risk selection failed: ${error.message}`);
    process.exitCode = 1;
  }
}
