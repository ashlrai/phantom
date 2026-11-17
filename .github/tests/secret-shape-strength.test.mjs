/* global URL */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const scrubPath = resolve(root, '.github/tests/secret-shape/scrub.pl');
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');

// Frozen pattern set. A change to scrub.pl fails this test until the same
// pattern is reviewed here, so the gate cannot get weaker by drift.
const EXPECTED = [
  ['slack_app', 'xapp-[0-9]+-[A-Za-z0-9-]{10,}'],
  ['slack', 'xox[abposr]-[A-Za-z0-9-]{10,}'],
  ['github', 'gh[pousr]_[A-Za-z0-9]{30,}'],
  ['github_pat', 'github_pat_[A-Za-z0-9_]{30,}'],
  ['gitlab', 'glpat-[A-Za-z0-9_-]{20,}'],
  ['anthropic', 'sk-ant-[A-Za-z0-9_-]{20,}'],
  ['openai', 'sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}'],
  ['stripe', '[sr]k_(?:live|test)_[A-Za-z0-9]{16,}'],
  ['stripe_wh', 'whsec_[A-Za-z0-9]{20,}'],
  ['aws', '(?:AKIA|ASIA)[A-Z0-9]{16}'],
  ['shopify', 'shp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}'],
  ['google', 'AIza[0-9A-Za-z_-]{35}'],
  ['npm', 'npm_[A-Za-z0-9]{36}'],
  ['jwt', 'eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}'],
  ['url_cred', '(?<=://)[^\\s:/@\\[]+:[^\\s/@]+(?=@)'],
];

function patterns(text) {
  const closer = { '{': '}', '(': ')', '[': ']' };
  const found = [];
  for (const line of text.split('\n')) {
    const open = /^\s*\[(\w+)\s+=>\s+qr(.)/.exec(line);
    if (!open) continue;
    const end = closer[open[2]] ?? open[2];
    const body = line.slice(open[0].length);
    const stop = body.lastIndexOf(`${end}],`);
    if (stop === -1) continue;
    found.push([open[1], body.slice(0, stop)]);
  }
  return found;
}

function token(kind) {
  const body = (length, alphabet) => Array.from({ length }, (_, i) => alphabet[i % alphabet.length]).join('');
  switch (kind) {
    case 'slack_app': return `xapp-1-${body(12, 'abc')}`;
    case 'slack': return `xoxb-${body(12, 'abc')}`;
    case 'github': return `ghp_${body(36, 'abc')}`;
    case 'github_pat': return `github_pat_${body(36, 'abc')}`;
    case 'gitlab': return `glpat-${body(24, 'abc')}`;
    case 'anthropic': return `sk-ant-${body(24, 'abc')}`;
    case 'openai': return `sk-${body(24, 'abc')}`;
    case 'stripe': return `sk_live_${body(20, 'abc')}`;
    case 'stripe_wh': return `whsec_${body(24, 'abc')}`;
    case 'aws': return `AKIA${body(16, 'ABCDEFGHIJKLMNOP')}`;
    case 'shopify': return `shpat_${body(32, 'abcdef')}`;
    case 'google': return `AIza${body(35, 'abc')}`;
    case 'npm': return `npm_${body(36, 'abc')}`;
    case 'jwt': return `eyJ${body(12, 'abc')}.eyJ${body(12, 'abc')}.${body(12, 'abc')}`;
    case 'url_cred': {
      const scheme = 'https://';
      const user = 'us' + 'er';
      const secret = 'pa' + 'ss';
      const host = 'example.invalid';
      return `${scheme}${user}:${secret}@${host}/path`;
    }
    default: throw new Error(`unknown kind ${kind}`);
  }
}

function diff(path, line) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+${line}\n`;
}

function scan(input, allow = true) {
  return spawnSync('perl', [scrubPath, '--check', ...(allow ? ['--allow-fixtures'] : [])], { input, encoding: 'utf8' });
}

test('scrub.pl keeps the frozen pattern set', () => {
  const parsed = patterns(readFileSync(scrubPath, 'utf8'));
  assert.deepEqual(parsed, EXPECTED);
  assert.equal(parsed.length, EXPECTED.length);
});

test('every pattern fixture fails, including outside the fixture allowlist', () => {
  for (const [kind] of EXPECTED) {
    const bad = scan(diff('src/app.ts', token(kind)));
    assert.equal(bad.status, 1, `${kind} must fail`);
    assert.match(bad.stdout, /^[1-9]/);
  }
  const pem = `-----BEGIN ${'RSA'} PRIVATE KEY-----\nMIIE\n-----END ${'RSA'} PRIVATE KEY-----\n`;
  assert.equal(scan(diff('src/app.ts', pem)).status, 1);
  const sample = token('github');
  const allowed = scan(diff('test/app.test.ts', sample.replace('ghp_', 'ghp_FAKE')));
  assert.equal(allowed.status, 0, allowed.stdout);
  assert.equal(scan(diff('src/app.ts', sample.replace('ghp_', 'ghp_FAKE'))).status, 1);
  assert.equal(scan(diff('test/app.test.ts', sample)).status, 1);
  const removed = `diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +0,0 @@\n-${token('slack')}\n`;
  assert.equal(scan(removed).status, 0);
});

test('the strength fixture source does not itself match the diff scan', () => {
  const text = readFileSync(new URL(import.meta.url), 'utf8');
  const added = text.split('\n').map((line) => `+${line}`).join('\n');
  const wrapped = `diff --git a/.github/tests/secret-shape-strength.test.mjs b/.github/tests/secret-shape-strength.test.mjs\n+++ b/.github/tests/secret-shape-strength.test.mjs\n@@ -0,0 +1 @@\n${added}\n`;
  const result = scan(wrapped);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(scan(diff('src/app.ts', token('url_cred'))).status, 1);
});

test('the hosted secret jobs always scan and never reuse a receipt', () => {
  const shape = workflow.slice(workflow.indexOf('name: Secret-shape scan'), workflow.indexOf('name: Quick typecheck'));
  const scanJob = workflow.slice(workflow.indexOf('name: Secret scan (diff)'), workflow.indexOf('name: Merge Gate'));
  assert.match(shape, /perl \.github\/tests\/secret-shape\/scrub\.pl --check --allow-fixtures/);
  assert.match(shape, /git diff --no-color --no-ext-diff/);
  assert.match(scanJob, /--log-opts="\$\{base\}\.\.\$\{HEAD_SHA\}"/);
  assert.match(scanJob, /pull_request\) base="\$\(git merge-base "\$PR_BASE" "\$HEAD_SHA"\)"/);
  assert.doesNotMatch(scanJob, /gitleaks detect/);
  assert.match(scanJob, /rm -f \.gitleaks\.toml \.gitleaksignore/);
  assert.doesNotMatch(shape, /ci-green-reuse/);
  assert.doesNotMatch(scanJob, /ci-green-reuse/);
  assert.doesNotMatch(shape, /shape_reuse/);
  assert.doesNotMatch(scanJob, /scan_reuse/);
  assert.doesNotMatch(`${shape}\n${scanJob}`, /~1/);
  assert.match(scanJob, /secret scan refused an incomplete commit range/);
  assert.match(scanJob, /github\.event\.before/);
});
