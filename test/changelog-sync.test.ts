import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'smol-toml';

const script = resolve('scripts/changelog-sync');
const fixture = resolve('test/fixtures/changelog-sync');
const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'changelog-sync-'));
  homes.push(home);
  const changelog = join(home, 'CHANGELOG.md');
  const snapshot = join(home, 'snapshot.json');
  writeFileSync(changelog, readFileSync(join(fixture, 'CHANGELOG.md')));
  writeFileSync(snapshot, readFileSync(join(fixture, 'snapshot.json')));
  const run = (mode: string, ...args: string[]) => execFileSync(script, [mode, '--snapshot', snapshot, '--changelog', changelog, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  return { home, changelog, snapshot, run };
}
it('ships a parseable conventional-commit cliff template', () => {
  const config = parse(readFileSync('cliff.toml', 'utf8'));
  expect(config.git).toMatchObject({ conventional_commits: true, filter_unconventional: true });
});
it('dry runs, deduplicates merged PR commits, preserves manual and released text, and is idempotent', () => {
  const { changelog, run } = setup();
  const original = readFileSync(changelog, 'utf8');
  const output = run('update');
  expect(readFileSync(changelog, 'utf8')).toBe(original);
  expect(output).toContain('**cli:** add search (#42)');
  expect(output.match(/add search/g)).toHaveLength(1);
  expect(output).toContain('handle empty input');
  expect(output).toContain('### Changed\n- maintain integration');
  expect(output).toContain('**BREAKING** replace old API');
  expect(output).not.toContain('not merged');
  expect(output).not.toContain('Merge branch');
  expect(output).toContain('Keep this manual note.');
  expect(output.split('## [1.0.0]')[1]).toBe(original.split('## [1.0.0]')[1]);
  run('update', '--write');
  expect(run('update')).toBe(output);
});
it('supports versioned Unreleased headings and CRLF release bodies', () => {
  const { changelog, snapshot, run } = setup();
  writeFileSync(changelog, readFileSync(changelog, 'utf8').replace('[Unreleased]', '[1.1.0] - Unreleased'));
  const data = JSON.parse(readFileSync(snapshot, 'utf8'));
  data.releases[0].body = data.releases[0].body.replace(/\n/g, '\r\n');
  writeFileSync(snapshot, JSON.stringify(data));
  expect(run('update')).toContain('add search');
  expect(run('verify')).toBe('Verified 1 tags\n');
});
it.each(['mismatch', 'missing release', 'draft', 'duplicate', 'missing section', 'empty tags', 'duplicate tags', 'empty body', 'unknown draft status', 'malformed block', 'unknown option'])('fails closed for %s', (scenario) => {
  const { changelog, snapshot, home } = setup();
  const data = JSON.parse(readFileSync(snapshot, 'utf8'));
  let mode = 'verify';
  if (scenario === 'mismatch') data.releases[0].body = 'different';
  if (scenario === 'missing release') data.releases = [];
  if (scenario === 'draft') data.releases[0].isDraft = true;
  if (scenario === 'duplicate') data.releases.push(data.releases[0]);
  if (scenario === 'empty tags') data.tags = [];
  if (scenario === 'duplicate tags') data.tags.push(data.tags[0]);
  if (scenario === 'empty body') data.releases[0].body = '  ';
  if (scenario === 'unknown draft status') delete data.releases[0].isDraft;
  if (scenario === 'missing section') writeFileSync(changelog, '# Empty\n');
  if (scenario === 'malformed block') {
    mode = 'update';
    writeFileSync(changelog, readFileSync(changelog, 'utf8').replace('### Notes', '<!-- changelog-sync:start -->\n### Notes'));
  }
  writeFileSync(snapshot, JSON.stringify(data));
  const result = spawnSync(script, [mode, '--snapshot', snapshot, '--changelog', changelog, ...(scenario === 'unknown option' ? ['--bogus'] : [])], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('changelog-sync:');
});
it('reads direct conventional commits from the explicit local base without a network call', () => {
  const { home, snapshot, changelog } = setup();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: home, encoding: 'utf8', env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '--quiet');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
  const base = git('rev-parse', 'HEAD');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fix: local regression');
  writeFileSync(snapshot, JSON.stringify({ base, pullRequests: [] }));
  const output = execFileSync(script, ['update', '--snapshot', snapshot, '--changelog', changelog], { cwd: home, encoding: 'utf8', env: { ...process.env, HOME: home } });
  expect(output).toContain('- local regression');
  expect(output).not.toContain('- initial');
});
