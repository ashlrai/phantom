import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetEmpties, fleetEmpties } from '../src/cli/fleet-empties.js';
import { readFleetEmpties } from '../src/core/fleet/empties.js';

// Qualifies PR #6577 at bc14a9c6491fb068d1eaee2fb50094180b760c4e.
const now = Date.parse('2026-11-17T12:00:00Z');
const row = (job: string, event: string, age: number, extra: object = {}) =>
  JSON.stringify({ job, event, lane: 'codex', ts: new Date(now - age * 1000).toISOString(), ...extra });
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('counts separate attempts and published finishes once while preserving unknowns and group rates', async () => {
  const ledger = [
    row('RQ-ALPHA1', 'launch', 500),
    row('RQ-ALPHA1', 'finish', 400, { empty: true, wall_s: 100, reason: 'scope-unclear' }),
    row('RQ-ALPHA1', 'launch', 300),
    row('RQ-ALPHA1', 'finish', 200, { empty: false }),
    row('RQ-ALPHA2', 'finish', 190),
    row('RQ-ALPHA2', 'publish', 180, { url: 'https://github.com/example/project/pull/1' }),
    row('RQ-ALPHA3', 'finish', 170),
    row('RQ-ALPHA4', 'finish', 160, { empty: true, wall_s: 100, reason: 'scope-unclear\nprecheck refused' }),
  ].join('\n');
  const report = await fleetEmpties(async () => ledger, 24, now);
  expect(report).toMatchObject({ finished: 5, measured: 4, total: 2, emptyRate: 0.5 });
  expect(report.empties.map(item => item.cause)).toEqual(['scope-unclear', 'unknown']);
  expect(report.groups).toEqual([{ family: 'RQ-ALPHA', lane: 'codex', finished: 5, measured: 4, empty: 2, emptyRate: 0.5 }]);
});

it('keeps note contents and escaping or symlinked paths out of the report and CLI', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'empty-qualification-')); roots.push(parent);
  const root = join(parent, 'runs'); await mkdir(join(root, 'metrics'), { recursive: true });
  await writeFile(join(root, 'inside.md'), 'Cause: scope-unclear\nsynthetic-note-marker');
  await writeFile(join(parent, 'outside.md'), 'Cause: already-done-on-main\nsynthetic-outside-marker');
  await symlink(join(parent, 'outside.md'), join(root, 'link.md'));
  await symlink(parent, join(root, 'escape'));
  const paths = ['inside.md', '../outside.md', join(parent, 'outside.md'), 'link.md', 'escape/outside.md'];
  const ledger = paths.map((notes_path, i) => row(`RQ-NOTE${i}`, 'finish', 100 + i, { empty: true, wall_s: 90, notes_path })).join('\n');
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), ledger);
  const report = await readFleetEmpties(24, now, root);
  expect(report).toMatchObject({ total: 5, notesMissing: 4, byCause: { 'scope-unclear': 1, 'already-done-on-main': 0, unknown: 4 } });
  const output = JSON.stringify(report);
  for (const value of ['synthetic-note-marker', 'synthetic-outside-marker', parent, 'outside.md']) expect(output).not.toContain(value);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetEmpties(['--runs-dir', root, '--json'], undefined, now)).toBe(0);
  const cli = String(log.mock.calls.at(-1)?.[0]);
  // The CLI adds the additive `why` block (fleet.empties.why.v1); the v2 report itself is unchanged.
  const { why, ...v2 } = JSON.parse(cli);
  expect(v2).toEqual(report);
  expect(why).toMatchObject({ schema: 'fleet.empties.why.v1', empties: 5 });
  for (const value of ['synthetic-note-marker', 'synthetic-outside-marker', parent, 'outside.md']) expect(cli).not.toContain(value);
});
