import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetGmailTriage } from '../src/cli/fleet-gmail-triage.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it('runs the bridge and creates only an eligible pending draft', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-')); dirs.push(dir);
  const runs = mkdtempSync(join(tmpdir(), 'runs-')); dirs.push(runs);
  writeFileSync(join(dir, 'person.eml'), 'From: pat@example.test\nMessage-ID: <p@example.test>\nSubject: Question?\nAuto-Submitted: no\n\nCan you reply?');
  writeFileSync(join(dir, 'auto.eml'), 'From: pat@example.test\nMessage-ID: <a@example.test>\nAuto-Submitted: auto-replied\n\nQuestion?');
  writeFileSync(join(dir, 'update.eml'), 'From: newsletter@example.test\nMessage-ID: <n@example.test>\nSubject: News\n\nHello');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetGmailTriage(['--dir', dir, '--runs-dir', runs, '--json'])).toBe(0);
  const output = JSON.parse(String(log.mock.calls[0]![0]));
  expect(output.schema).toBe('fleet.gmail-triage.v1');
  expect(output.report).toMatchObject({ scanned: 3, drafted: 1, review: 1, failed: 0 });
  expect(output.archivePlan).toEqual({ unread: 3, target: 100, archiveCandidates: [] });
  const draft = JSON.parse(readFileSync(join(runs, 'drafts', 'drafts.jsonl'), 'utf8').trim());
  expect(draft).toMatchObject({ status: 'pending', to: 'pat@example.test', body: 'Thanks, I have this and will reply properly soon.' });
  expect(readFileSync(join(dir, 'person.eml'), 'utf8')).toContain('Question?');
});
it('returns usage error for a missing directory', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetGmailTriage([])).toBe(2);
  expect(await cmdFleetGmailTriage(['--dir', '/nonexistent/triage-folder'])).toBe(2);
});
