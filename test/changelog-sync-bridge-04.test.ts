import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const script = resolve('scripts/changelog-sync');
const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const changelog = '# Changelog\n\n## [Unreleased]\n\nManual note.\n\n## [1.0.0] - 2026-01-01\n\nOld.\n';
function sync(titles: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'changelog-bridge-'));
  homes.push(home);
  const snapshot = {
    commits: [],
    pullRequests: titles.map((title, i) => ({ number: 9000 + i, title, mergedAt: '2026-11-01T00:00:00Z', mergeCommit: { oid: `fake${i}` }, commits: [] })),
  };
  writeFileSync(join(home, 'CHANGELOG.md'), changelog);
  writeFileSync(join(home, 'snapshot.json'), JSON.stringify(snapshot));
  return execFileSync(script, ['update', '--snapshot', join(home, 'snapshot.json'), '--changelog', join(home, 'CHANGELOG.md')], { encoding: 'utf8', env: { ...process.env, HOME: home } });
}

it.each([
  'bridge(RQ-PHX-NEEDSANSWERSTOP03SOPK1): BRIDGE_NOTES — RQ-PHX-NEEDSANSWERSTOP03SOPK1',
  'bridge(RQ-PHX-X): Bridge notes',
  'bridge(RQ-PHX-Y): Bridge Notes: RQ-PHX-Y',
  'bridge(RQ-ZAI-TYPES-ANY-SWEEP): BRIDGE_NOTES.md — RQ-ZAI-TYPES-ANY-SWEEP',
  'bridge(RQ-RESOURCES-2-PANEL): RQ-RESOURCES-2-PANEL',
  'bridge(RQ-PHX-Z): handoff',
  'bridge(RQ-PHX-Z): Handoff - RQ-PHX-Z',
  'bridge(FIXUP-MAIN-phantom-947d8f6-r2): Bridge Notes: FIXUP-MAIN-phantom-947d8f6-r2',
  'bridge(FIXUP-MAIN-phantom-947d8f6-r2): repair the main build',
])('omits %s', (title) => {
  const out = sync([title]);
  expect(out).not.toMatch(/\(#9000\)/);
  expect(out).not.toContain('### Changed');
});

it.each([
  ['bridge(RQ-PHX-A): RQ-PHX-A: Email needs roundtrip', '- **RQ-PHX-A:** Email needs roundtrip (#9000)'],
  ['bridge(RQ-PHX-B): RQ-PHX-B — Telegram fleet pulse verb', '- **RQ-PHX-B:** Telegram fleet pulse verb (#9000)'],
  ['bridge(RQ-PHX-C): RQ-PHX-C - plain dash subject', '- **RQ-PHX-C:** plain dash subject (#9000)'],
  ['bridge(RQ-LANEYIELDQ8): RQ-LANEYIELDQ8: `ashlr fleet lane-yield`', '- **RQ-LANEYIELDQ8:** `ashlr fleet lane-yield` (#9000)'],
  ['bridge(RQ-PHX-D): BRIDGE_NOTES.md — cross-channel merged ack text', '- **RQ-PHX-D:** cross-channel merged ack text (#9000)'],
  ['bridge(RQ-PHX-E): Email needs roundtrip', '- **RQ-PHX-E:** Email needs roundtrip (#9000)'],
  ['bridge(RQ-DRAIN-F): drain queue ordering fix', '- **RQ-DRAIN-F:** drain queue ordering fix (#9000)'],
])('keeps %s', (title, line) => {
  const out = sync([title]);
  expect(out).toContain(`### Changed\n${line}\n`);
});

it('leaves other types untouched and mixes with bridge entries', () => {
  const out = sync(['feat(fleet): x', 'bridge(RQ-PHX-G): BRIDGE_NOTES — RQ-PHX-G', 'bridge(RQ-PHX-H): real change', 'chore(deps): bump y']);
  expect(out).toContain('### Added\n- **fleet:** x (#9000)');
  expect(out).toContain('### Changed\n- **RQ-PHX-H:** real change (#9002)\n- **deps:** bump y (#9003)');
  expect(out).not.toContain('RQ-PHX-G');
});

it('leaves no empty Changed heading for an all-boilerplate snapshot', () => {
  const out = sync(['bridge(RQ-PHX-A): Bridge notes', 'bridge(RQ-PHX-B): BRIDGE_NOTES — RQ-PHX-B', 'bridge(FIXUP-MAIN-x): fix main']);
  expect(out).not.toContain('### ');
  expect(out).toContain('Manual note.');
});
