import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cmdFleetMission } from '../src/cli/fleet-mission.js';
import { emptyMission, missionOverview, parseRouterDecisions, readMissionControl } from '../src/core/fleet/mission-control.js';
import { VERSE_FLEET_MISSION_PATH } from '../src/core/fleet/mission-control-types.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { workbenchFamilyFor } from '../src/core/verse/workbench-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

const NOW = Date.parse('2026-11-02T04:30:00Z');
const SECRET = 'sk-abcdefghijklmnopqrst';
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-mission-'));
  dirs.push(dir);
  return dir;
}

async function fleet(): Promise<string> {
  const dir = await root();
  await mkdir(join(dir, 'queue'), { recursive: true });
  await mkdir(join(dir, 'metrics'), { recursive: true });
  await mkdir(join(dir, 'supervisor'), { recursive: true });
  await mkdir(join(dir, 'leader'), { recursive: true });
  const epoch = Math.floor(Date.parse('2026-11-02T04:00:00Z') / 1000);
  await writeFile(join(dir, 'queue/status.json'), JSON.stringify({
    last_tick: '2026-11-02T04:29:00Z', paused: false, mem_free_pct: 41,
    lanes: {
      'codex-personal': { running: 1, target: 2, queued: 3, held: false },
      devin: { running: 0, target: 1, queued: 1, held: false },
      claude: { running: 0, target: 1, queued: 0, held: true, held_reason: 'usage' },
    },
  }));
  await writeFile(join(dir, 'queue/claimed.tsv'), `RQ-1\tcodex-personal\tfrontier\t04:00\t${epoch}\n`);
  await writeFile(join(dir, 'models.json'), JSON.stringify({ 'codex-personal.frontier': 'gpt-5.4', 'devin.work': 'devin' }));
  await writeFile(join(dir, 'queue/resources.json'), JSON.stringify({
    'codex-personal': { usage_left: 18, reset_at: '2026-11-03T06:00:00Z' },
    claude: { usage_left: 0, reset_at: '2026-11-04T12:00:00Z' },
    'codex-cmp': { weekly_used_pct: 40, reset_at: '2026-11-09T00:00:00Z' },
  }));
  await writeFile(join(dir, 'queue/dispatch-events.log'), [
    `2026-11-02 04:05:00 ROUTE job=RQ-9 resource=codex-personal model=gpt-5.4 because the weekly window still has room`,
    `2026-11-02 04:06:00 LAUNCH job=RQ-10 resource=devin model=devin why=local models are full ${SECRET}`,
  ].join('\n'));
  await writeFile(join(dir, 'metrics/jobs.jsonl'), [
    JSON.stringify({ job: 'RQ-1', event: 'pr-merge', at: '2026-11-02T04:10:00Z', prUrl: 'https://github.com/ashlrai/phantom/pull/42' }),
    JSON.stringify({ job: 'RQ-2', event: 'pr-merge', at: '2026-11-02T04:20:00Z', prUrl: 'https://github.com/ashlrai/locus/pull/7' }),
    JSON.stringify({ job: 'RQ-old', event: 'pr-merge', at: '2026-11-02T02:00:00Z', prUrl: 'https://github.com/ashlrai/phantom/pull/1' }),
  ].join('\n'));
  await writeFile(join(dir, 'supervisor/status-phantom.md'), '# ashlrai/phantom\nstatus: red\nMain failed typecheck.\nfix: RQ-PHX-9\n');
  await writeFile(join(dir, 'supervisor/status-locus.md'), 'repo: ashlrai/locus\nstatus: green\n');
  await writeFile(join(dir, 'leader/INCIDENTS.md'), [
    '## OPEN phantom main went red',
    'Typecheck failed after a merge.',
    'Applied: opened RQ-PHX-9',
    '',
    '## FIXED memory pause',
    'The machine ran out of room. See /Users/mason/secret',
    'Applied: stopped two jobs until memory recovered.',
  ].join('\n'));
  await writeFile(join(dir, 'leader/VISION.md'), `# This week\n- Keep every main green\n- ${SECRET}\n`);
  await writeFile(join(dir, 'memstat.json'), JSON.stringify({ free_pct: 41, swap_gb: 0, swapouts_per_min: 0, disk_gb: 80, ts: '2026-11-02T04:29:00Z' }));
  await writeFile(join(dir, '.memguard2.json'), JSON.stringify({ level: 'normal', stopped: [] }));
  return dir;
}

describe('fleet mission briefing', () => {
  it('reads a realistic fleet and hides secrets', async () => {
    const view = await readMissionControl({ runsDir: await fleet(), now: () => NOW });
    expect(view.schema).toBe('fleet.mission.v1');
    expect(view.overview).toMatchObject({ health: 'attention', headline: 'Something needs a look.', shipped: '2 pulls merged this hour.' });
    expect(view.overview.items.map((item) => item.text)).toEqual([
      'ashlrai/phantom main is red. 1 fix job is open.',
      'phantom main went red',
      'Claude is out of time.',
      'Personal Codex is almost out of time.',
    ]);
    expect(view.jobs).toEqual([
      { resource: 'devin', label: 'Devin', model: null, running: 0, queued: 1 },
      { resource: 'codex-personal', label: 'Personal Codex', model: null, running: 0, queued: 3 },
      { resource: 'codex-personal', label: 'Personal Codex', model: 'gpt-5.4', running: 1, queued: 0 },
    ]);
    expect(view.decisions.map((row) => [row.resource, row.model, row.why])).toEqual([
      ['devin', 'devin', 'local models are full [REDACTED]'],
      ['codex-personal', 'gpt-5.4', 'the weekly window still has room'],
    ]);
    expect(view.resources.find((row) => row.id === 'claude')).toMatchObject({ leftPct: 0, resetAt: '2026-11-04T12:00:00Z', source: 'resources.json' });
    expect(view.resources.find((row) => row.id === 'codex-cmp')).toMatchObject({ leftPct: 60 });
    expect(view.merges).toEqual([
      { repo: 'ashlrai/locus', perHour: 1, pulls: [{ repo: 'ashlrai/locus', number: 7, url: 'https://github.com/ashlrai/locus/pull/7' }] },
      { repo: 'ashlrai/phantom', perHour: 1, pulls: [{ repo: 'ashlrai/phantom', number: 42, url: 'https://github.com/ashlrai/phantom/pull/42' }] },
    ]);
    expect(view.mains).toEqual([
      { repo: 'ashlrai/locus', health: 'green', fixJobs: [], note: null },
      { repo: 'ashlrai/phantom', health: 'red', fixJobs: ['RQ-PHX-9'], note: 'Main failed typecheck.' },
    ]);
    expect(view.incidents[0]).toMatchObject({ status: 'open', applied: 'opened RQ-PHX-9' });
    expect(view.incidents[1]).toMatchObject({ status: 'fixed', applied: 'stopped two jobs until memory recovered.' });
    expect(view.memory).toMatchObject({ freePct: 41, pressure: 'calm', stale: false, note: 'Memory is fine.' });
    expect(view.plan).toEqual({ title: 'This week', points: ['Keep every main green', '[REDACTED]'] });
    const wire = JSON.stringify(view);
    expect(wire).not.toContain(SECRET);
    expect(wire).not.toContain('/Users/mason');
  });

  it('stays unknown when the directory is missing and falls back to the usage journal', async () => {
    const missing = await readMissionControl({ runsDir: join(await root(), 'absent'), now: () => NOW });
    expect(missing.overview.health).toBe('unknown');
    expect(missing.jobs).toEqual([]);
    expect(Object.values(missing.sources).every((state) => state === 'missing')).toBe(true);

    const dir = await root();
    await mkdir(join(dir, 'queue'), { recursive: true });
    await writeFile(join(dir, 'queue/usage-readings.log'), JSON.stringify({
      pool: 'codex-personal', pctUsed: 10, resetAt: '2026-11-03T06:00:00Z', fetchedAt: '2026-11-02T04:00:00Z',
    }));
    const view = await readMissionControl({ runsDir: dir, now: () => NOW });
    expect(view.resources).toEqual([{
      id: 'codex-personal', label: 'Personal Codex', leftPct: 90, creditsLeft: null,
      resetAt: '2026-11-03T06:00:00Z', source: 'usage-readings.log',
    }]);
    expect(view.sources.resources).toBe('healthy');
  });

  it('does not follow a status symlink', async () => {
    const dir = await root();
    await mkdir(join(dir, 'supervisor'), { recursive: true });
    const outside = join(dir, 'secret.md');
    await writeFile(outside, `status: red\n${SECRET}\n`);
    await symlink(outside, join(dir, 'supervisor/status-phantom.md'));
    const view = await readMissionControl({ runsDir: dir, now: () => NOW });
    expect(view.mains).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it('prints the same sentences as the document', async () => {
    const dir = await fleet();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetMission(['--json', '--root', dir])).toBe(0);
    const view = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { overview: { headline: string } };
    expect(view.overview.headline).toBe('Something needs a look.');
    expect(await cmdFleetMission(['--help'])).toBe(0);
    expect(await cmdFleetMission(['--root', 'relative'])).toBe(2);
  });
});

describe('mission overview', () => {
  it('says the fleet is moving when nothing needs a look', () => {
    expect(missionOverview({
      reported: true, mergesReported: true, merges: 0, mains: [{ repo: 'ashlrai/locus', health: 'green', fixJobs: [], note: null }],
      incidents: [], resources: [], memory: { pressure: 'calm', stale: false },
    })).toMatchObject({ health: 'clear', headline: 'Everything is moving.', attention: 'Nothing needs you.', shipped: 'Nothing merged this hour.' });
  });

  it('does not treat a missing merge file as zero', () => {
    expect(emptyMission(NOW).overview.shipped).toBe('Merges have not reported.');
  });
});

describe('router lines', () => {
  it('keeps the newest choices and drops a bad clock', () => {
    const rows = parseRouterDecisions('2026-02-30 00:00:00 ROUTE job=RQ-1\n2026-11-02 04:00:00 PICK resource=claude model=opus because the other window reset\n');
    expect(rows).toEqual([{ at: '2026-11-02T04:00:00Z', resource: 'claude', label: 'Claude', model: 'opus', job: null, why: 'the other window reset' }]);
  });
});

describe('mission route', () => {
  it('is owned by the fleet runs family and returns the briefing', async () => {
    expect(workbenchFamilyFor(VERSE_FLEET_MISSION_PATH)?.id).toBe('fleet-runs');
    const briefing = emptyMission(NOW);
    const api = createFleetRunsApi({ readMission: async () => briefing, now: () => NOW });
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.url = VERSE_FLEET_MISSION_PATH;
    req.method = 'GET';
    req.headers = {};
    let status = 0;
    let wire = '';
    const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; }, end(text: string) { wire = text; } } as unknown as ServerResponse;
    const handled = await api({ cfg: {} as AshlrConfig, token: 't', allowDispatch: false } as VerseApiContext, req, res, VERSE_FLEET_MISSION_PATH, 'GET');
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(JSON.parse(wire)).toMatchObject({ schema: 'fleet.mission.v1', overview: { health: 'unknown' } });
  });
});
