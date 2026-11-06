/**
 * The reviewer runs as a REAL separate process here (node running a fixture
 * script), so these tests prove what the child actually sees: no GitHub, git,
 * ssh or cloud credential from the parent env, a HOME that is not the parent's,
 * an empty private cwd removed afterwards, a fresh scratch per review, and the
 * prompt on stdin only (never a shell, never argv).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildReviewerEnv, runReviewerProcess, type ReviewerScratch } from '../src/core/fleet/cross-review-process.js';
import type { CrossReviewer } from '../src/core/fleet/cross-review.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'xreview-proc-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A fixture reviewer: records what it can see to `report`, then prints `answer`. */
function fixtureReviewer(answer: string, extra: Partial<CrossReviewer> = {}): CrossReviewer {
  const script = join(dir, 'reviewer.cjs');
  const report = join(dir, 'report.json');
  writeFileSync(script, `
const fs = require('fs');
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({
    env: process.env, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), stdin, argv: process.argv.slice(2),
  }));
  process.stdout.write(${JSON.stringify(answer)});
});
`);
  return { pool: 'mac-b', model: 'local:fixture', bin: process.execPath, args: [script], credentialEnv: [], timeoutMs: 20_000, ...extra };
}

function readReport(): { env: Record<string, string>; cwd: string; cwdEntries: string[]; stdin: string; argv: string[] } {
  return JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
}

const APPROVE = '{"verdict":"approve","reasons":["correct-and-scoped"]}';
const PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  HOME: '/Users/someone-real',
  GH_TOKEN: 'gho_fake_parent_token',
  GITHUB_TOKEN: 'ghp_fake_parent_token',
  GH_CONFIG_DIR: '/Users/someone-real/.config/gh',
  GIT_ASKPASS: '/usr/local/bin/askpass',
  SSH_AUTH_SOCK: '/tmp/agent.sock',
  ASHLR_HOME: '/Users/someone-real/.ashlr',
  AWS_SECRET_ACCESS_KEY: 'fake',
  ANTHROPIC_API_KEY: 'fake',
  OPENAI_API_KEY: 'fake',
  NODE_OPTIONS: '--require /tmp/evil.js',
  CLAUDE_CODE_OAUTH_TOKEN: 'fake-claude-oauth',
};

describe('isolated reviewer process', { timeout: 20_000 }, () => {
  it('inherits no credential, no parent HOME and no parent env beyond PATH', async () => {
    const result = await runReviewerProcess(fixtureReviewer(APPROVE), 'PROMPT', { parentEnv: PARENT_ENV });
    expect(result).toEqual({ ok: true, verdict: { verdict: 'approve', reasons: ['correct-and-scoped'] } });
    const seen = readReport();
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'ASHLR_HOME',
      'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      expect(seen.env[name], name).toBeUndefined();
    }
    expect(seen.env['HOME']).not.toBe(PARENT_ENV['HOME']);
    expect(seen.env['HOME']!.startsWith(seen.cwd.replace(/\/work$/, ''))).toBe(true);
    // Nothing whose value came from the parent except PATH.
    const parentValues = new Set(Object.entries(PARENT_ENV).filter(([k]) => k !== 'PATH').map(([, v]) => v));
    for (const [name, value] of Object.entries(seen.env)) expect(parentValues.has(value), name).toBe(false);
  });

  it('passes only the allowed model credential to a claude-family reviewer, never a GitHub one', () => {
    const scratch: ReviewerScratch = { root: '/s', cwd: '/s/work', home: '/s/home', tmp: '/s/tmp' };
    const env = buildReviewerEnv({ credentialEnv: ['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] }, scratch, PARENT_ENV);
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('fake-claude-oauth');
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['HOME']).toBe('/s/home');
    expect(env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
  });

  it('runs in an empty private scratch that is removed afterwards and never reused', async () => {
    const roots: string[] = [];
    const onScratch = (s: ReviewerScratch): void => {
      roots.push(s.root);
      expect(statSync(s.root).mode & 0o077).toBe(0);
    };
    await runReviewerProcess(fixtureReviewer(APPROVE), 'one', { parentEnv: PARENT_ENV, onScratch });
    expect(readReport().cwdEntries).toEqual([]);
    await runReviewerProcess(fixtureReviewer(APPROVE), 'two', { parentEnv: PARENT_ENV, onScratch });
    expect(roots).toHaveLength(2);
    expect(roots[0]).not.toBe(roots[1]);
    for (const root of roots) expect(existsSync(root)).toBe(false);
  });

  it('delivers job text on stdin only, with no shell evaluation and nothing in argv', async () => {
    const canary = join(dir, 'pwned');
    const prompt = `title $(touch ${canary}) \`touch ${canary}\` ; touch ${canary} | rm -rf / && echo`;
    await runReviewerProcess(fixtureReviewer(APPROVE), prompt, { parentEnv: PARENT_ENV });
    const seen = readReport();
    expect(seen.stdin).toBe(prompt);
    expect(seen.argv).toEqual([]);
    expect(existsSync(canary)).toBe(false);
  });

  it('fails closed on malformed output, non-zero exit, oversize output, timeout and refused launches', async () => {
    expect(await runReviewerProcess(fixtureReviewer('LGTM, approve'), 'p', { parentEnv: PARENT_ENV }))
      .toEqual({ ok: false, failure: 'unparseable-verdict' });

    const failing = join(dir, 'fail.cjs');
    writeFileSync(failing, `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(APPROVE)}); process.exit(3); });`);
    expect(await runReviewerProcess({ ...fixtureReviewer(APPROVE), args: [failing] }, 'p', { parentEnv: PARENT_ENV }))
      .toEqual({ ok: false, failure: 'exit-nonzero' });

    const loud = join(dir, 'loud.cjs');
    writeFileSync(loud, `process.stdout.write('x'.repeat(200000));`);
    expect(await runReviewerProcess({ ...fixtureReviewer(APPROVE), args: [loud] }, 'p', { parentEnv: PARENT_ENV }))
      .toEqual({ ok: false, failure: 'output-too-large' });

    const slow = join(dir, 'slow.cjs');
    writeFileSync(slow, `setTimeout(() => {}, 60000);`);
    expect(await runReviewerProcess({ ...fixtureReviewer(APPROVE), args: [slow], timeoutMs: 1_000 }, 'p', { parentEnv: PARENT_ENV }))
      .toEqual({ ok: false, failure: 'timeout' });

    expect(await runReviewerProcess({ ...fixtureReviewer(APPROVE), credentialEnv: ['GH_TOKEN'] }, 'p', { parentEnv: PARENT_ENV }))
      .toEqual({ ok: false, failure: 'launch-refused' });
    expect(await runReviewerProcess({ ...fixtureReviewer(APPROVE), bin: '/bin/sh', args: ['-c', 'echo hi'] }, 'p', { parentEnv: PARENT_ENV }))
      .toEqual({ ok: false, failure: 'launch-refused' });
  }, 30_000);
});
