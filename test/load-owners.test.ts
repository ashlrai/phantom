/** Who owns the machine's load: fixture ps text and admission text in, typed producers out. No real host reads. */
import { describe, expect, it } from 'vitest';
import { cmdHost } from '../src/cli/host.js';
import { groupHostLoad } from '../src/core/fleet/host-load.js';
import { parseAdmissionCtl, summarizeLoadOwners } from '../src/core/fleet/load-owners.js';

const ps = (rows: Array<[number, number, number, string]>) =>
  ['  PID  PPID  %CPU   RSS COMM', ...rows.map(([pid, ppid, cpu, comm]) => `${pid} ${ppid} ${cpu} 1024 ${comm}`)].join('\n');
const MIN = 60_000;
const NOW = 10_000 * MIN;

describe('summarizeLoadOwners', () => {
  // A local model uses most of the machine; one Claude loop job is running; the admission guard owns nothing.
  const busy = ps([[1, 0, 0, 'launchd'], [400, 1, 20, 'node'], [401, 400, 10, 'node'], [600, 1, 410, '/opt/bin/mlx-server'], [700, 1, 270, 'WindowServer'], [800, 1, 30, 'guardian']]);
  const report = groupHostLoad(busy, [{ jobId: 'RQ-CL-ONE', pid: 400 }], { load1: 40, cores: 18, now: 0 });
  const waiting = parseAdmissionCtl(JSON.stringify({ why: 'load too high', settle_s: 300, load1: 40, owned_load1: 0 }));

  it('names the owner of a busy machine that is not the fleet, and shares sum to 100', () => {
    const owners = summarizeLoadOwners(report, { admission: waiting, now: NOW });
    expect(owners.schema).toBe('host.load.owners.v1');
    expect(owners.producers.reduce((sum, p) => sum + p.sharePercent, 0)).toBeGreaterThanOrEqual(99);
    expect(owners.producers.reduce((sum, p) => sum + p.sharePercent, 0)).toBeLessThanOrEqual(101);
    const share = (id: string) => owners.producers.find(p => p.id === id)!;
    expect(share('local-models').sharePercent).toBe(55);
    expect(share('claude-loop').sharePercent).toBe(4);
    expect(share('guardian').sharePercent).toBe(4);
    expect(owners.admission).toMatchObject({ state: 'waiting', why: 'load too high', settleSeconds: 300, ownedLoad1: 0 });
    expect(owners.summary).toBe('waiting (load too high), 0% of the load is fleet jobs; top owner: local model 55%');
    expect(owners.nextStep).toBe('Pause or quit the local model; the fleet starts more jobs once load drops.');
    expect(owners.idleJobs).toEqual([]);
  });

  it('flags a job idle over 45 minutes that still uses CPU, and not a recently active or quiet one', () => {
    const old = new Map([['RQ-CL-ONE', NOW - 46 * MIN]]);
    const flagged = summarizeLoadOwners(report, { admission: waiting, logMtimes: old, now: NOW });
    expect(flagged.idleJobs).toEqual([{ job: 'RQ-CL-ONE', cpuPercent: 30, idleMinutes: 46 }]);
    expect(flagged.summary).toContain('job RQ-CL-ONE has had no log output for 46 minutes but still uses 30% CPU');
    expect(flagged.nextStep).toContain('RQ-CL-ONE');
    expect(summarizeLoadOwners(report, { logMtimes: new Map([['RQ-CL-ONE', NOW - 44 * MIN]]), now: NOW }).idleJobs).toEqual([]);
    const quiet = groupHostLoad(ps([[400, 1, 1, 'node']]), [{ jobId: 'RQ-CL-ONE', pid: 400 }], { load1: 0.5, cores: 18, now: 0 });
    expect(summarizeLoadOwners(quiet, { logMtimes: old, now: NOW }).idleJobs).toEqual([]);
  });

  it('an idle machine has nothing to flag and nothing to do', () => {
    const idle = groupHostLoad(ps([[1, 0, 0, 'launchd']]), [], { load1: 0.2, cores: 18, now: 0 });
    const owners = summarizeLoadOwners(idle, { admission: parseAdmissionCtl('{}'), now: NOW });
    expect(owners.idleJobs).toEqual([]);
    expect(owners.producers.every(p => p.sharePercent === 0)).toBe(true);
    expect(owners.nextStep).toBe('Nothing to do.');
  });

  it('groups job ids by producer and tolerates a missing or broken admission file', () => {
    const mixed = groupHostLoad(ps([[10, 1, 10, 'node'], [20, 1, 10, 'node'], [30, 1, 10, 'node'], [40, 1, 10, 'node']]),
      [{ jobId: 'RQ-CL-A', pid: 10 }, { jobId: 'RQ-DVL-B', pid: 20 }, { jobId: 'RQ-DEVINCLOUD-C', pid: 30 }, { jobId: 'RQ-PLAIN', pid: 40 }], { load1: 4, cores: 18, now: 0 });
    const owners = summarizeLoadOwners(mixed, { admission: parseAdmissionCtl('not json'), now: NOW });
    expect(owners.producers.filter(p => p.sharePercent > 0).map(p => [p.id, p.sharePercent])).toEqual([['dispatchd-jobs', 25], ['claude-loop', 25], ['devin-cloud', 50]]);
    expect(owners.fleetSharePercent).toBe(100);
    expect(owners.admission.state).toBe('unknown');
  });

  it('phm host load --json carries owners from injected inputs', async () => {
    let out = '';
    const code = await cmdHost(['load', '--json'], {
      write: text => { out += text; }, ps: async () => busy, jobRoots: () => [{ jobId: 'RQ-CL-ONE', pid: 400 }],
      load: () => ({ load1: 40, load5: 40, load15: 40, cores: 18, ratio: 2.2 }), now: () => NOW,
      owners: () => ({ admission: waiting, logMtimes: new Map() }),
    });
    expect(code).toBe(0);
    expect(JSON.parse(out).owners.summary).toContain('top owner: local model 55%');
  });
});
