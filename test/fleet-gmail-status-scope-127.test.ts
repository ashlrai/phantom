import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetGmailStatus } from '../src/cli/fleet-gmail-status.js';
import { gmailTriageLatestPath, writeGmailTriageLatest } from '../src/core/comms/gmail-triage-latest.js';

const dirs: string[] = [];
const counts = { scanned: 2, updates: 1, drafted: 0, review: 0, failed: 0, unreadInSample: 2, target: 5, archiveCandidateCount: 0 };
const first = { source: 'local-eml-export' as const, files: 20, limit: 5, truncated: true };
const second = { source: 'local-eml-export' as const, files: 3, limit: 10, truncated: false };
function store(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-scope-'));
  dirs.push(dir);
  return dir;
}
async function run(dir: string, json = false): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await cmdFleetGmailStatus(['--runs-dir', dir, ...(json ? ['--json'] : [])])).toBe(0);
    return log.mock.calls.map(call => call.join(' ')).join('\n');
  } finally { log.mockRestore(); }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('projects each inbox scope and the latest scope without mixing evidence', async () => {
  const dir = store();
  writeGmailTriageLatest(dir, { ...counts, dir: '/private/alpha', scope: first });
  writeGmailTriageLatest(dir, { ...counts, dir: '/private/beta', scope: second });
  const path = gmailTriageLatestPath(dir);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.latest.scope.extra = 'secret-content';
  raw.inboxes.beta.scope.extra = 'secret-content';
  writeFileSync(path, JSON.stringify(raw));
  const json = await run(dir, true);
  const report = JSON.parse(json);
  expect(report.triage.scope).toEqual(second);
  expect(report.triageInboxes.map((entry: { label: string; scope: unknown }) => [entry.label, entry.scope]))
    .toEqual([['alpha', first], ['beta', second]]);
  expect(report.liveInbox).toBe('unknown');
  expect(report.archiveExecution).toBe('unverified');
  const text = await run(dir);
  expect(text.split('\n').find(line => line.startsWith('Triage:'))).toContain('scan limit 10; saved files 3; truncated false');
  expect(text.split('\n').find(line => line.startsWith('- "alpha"'))).toContain('scan limit 5; saved files 20; truncated true');
  expect(text.split('\n').find(line => line.startsWith('- "beta"'))).toContain('scan limit 10; saved files 3; truncated false');
  for (const output of [json, text]) {
    expect(output).not.toContain('/private');
    expect(output).not.toContain('secret-content');
  }
});

it.each(['legacy', 'malformed'])('reports %s scope as unknown', async state => {
  const dir = store();
  writeGmailTriageLatest(dir, { ...counts, dir: 'legacy' });
  const path = gmailTriageLatestPath(dir);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const record = raw.latest;
  if (state === 'malformed') record.scope = { ...first, limit: 0, extra: 'secret-content' };
  writeFileSync(path, JSON.stringify(record));
  const json = await run(dir, true);
  const report = JSON.parse(json);
  expect(report.triage).not.toHaveProperty('scope');
  expect(report.triageInboxes[0]).not.toHaveProperty('scope');
  const text = await run(dir);
  expect(text.match(/scope unknown/g)).toHaveLength(2);
  expect(json + text).not.toContain('secret-content');
});

it('preserves missing store behavior', async () => {
  const dir = store();
  const report = JSON.parse(await run(dir, true));
  expect(report.triage.state).toBe('missing');
  expect(report.triage).not.toHaveProperty('scope');
  expect(report.triageInboxes).toEqual([]);
  expect(await run(dir)).toContain('Triage: missing');
});
