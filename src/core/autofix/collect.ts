/**
 * Read-only collection for a live `phm autofix` run.
 * Missing tools become empty sections. Nothing here disables, renices or dispatches.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDispatchdBinary, isSandboxProfileName, sha256Hex } from './fixers.js';
import { launchdRunsLedgerPath, parseJsonlRecords } from './guard.js';
import { launchAgentsDir, newestRollbackMtime } from './launchd.js';
import {
  LAUNCHD_LABEL_RE, LOAD_PER_CPU, PINNED_NAMES, SHA_RE, defaultLaunchdJob, isAutofixRecord,
  type AutofixHost, type AutofixSnapshot, type LaunchdJob, type Proc, type ReleaseDraft, type RunsSample,
} from './types.js';

function execText(host: AutofixHost, argv: readonly string[]): string | null {
  const result = host.exec(argv);
  return result.code === 0 ? result.stdout : null;
}

export function collectSnapshot(host: AutofixHost): AutofixSnapshot {
  const releases = collectReleases(host);
  return {
    releases: releases.drafts,
    attestShas: releases.attestShas,
    autorunLog: host.readText(join(host.runsDir(), 'release-sign', 'autorun', 'autorun.log')) ?? '',
    launchdJobs: collectLaunchd(host),
    lanes: collectLanes(host),
    ...collectLoad(host),
    loadPerCpu: LOAD_PER_CPU,
    pinned: collectPinned(host),
  };
}

function collectReleases(host: AutofixHost): { drafts: ReleaseDraft[]; attestShas: string[] } {
  const listed = execText(host, ['gh', 'api', 'repos/ashlrai/phantom/releases?per_page=20']);
  const attested = execText(host, ['gh', 'api', 'repos/ashlrai/phantom/actions/workflows/attest-ci-build.yml/runs?status=success&per_page=20']);
  return { drafts: listed ? parseReleases(listed) : [], attestShas: attested ? parseAttestShas(attested) : [] };
}

function parseReleases(text: string): ReleaseDraft[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const drafts: ReleaseDraft[] = [];
  for (const release of parsed) {
    if (!isAutofixRecord(release)) continue;
    const tag = release.tag_name;
    const sha = release.target_commitish;
    const created = typeof release.created_at === 'string' ? Date.parse(release.created_at) : Number.NaN;
    const assets = Array.isArray(release.assets) ? release.assets.length : null;
    if (typeof release.id !== 'number' || typeof tag !== 'string' || typeof sha !== 'string' || assets === null || !Number.isFinite(created)) continue;
    drafts.push({ id: release.id, tag, sha, draft: release.draft === true, assetCount: assets, createdAtMs: created });
  }
  return drafts;
}

function parseAttestShas(text: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const runs = isAutofixRecord(parsed) ? parsed.workflow_runs : null;
  if (!Array.isArray(runs)) return [];
  const shas: string[] = [];
  for (const run of runs) {
    if (!isAutofixRecord(run)) continue;
    if (run.conclusion === 'success' && typeof run.head_sha === 'string' && SHA_RE.test(run.head_sha)) shas.push(run.head_sha);
  }
  return shas;
}

function parseLaunchctlList(text: string): string[] {
  const labels: string[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const label = fields[fields.length - 1];
    if (!label || label === 'Label' || !LAUNCHD_LABEL_RE.test(label)) continue;
    labels.push(label);
  }
  return labels;
}

function collectLaunchd(host: AutofixHost): LaunchdJob[] {
  const listed = execText(host, ['launchctl', 'list']);
  if (listed === null) return [];
  const journal = readJournal(host.readText(launchdRunsLedgerPath(host.runsDir())));
  const dir = launchAgentsDir(host);
  const names = host.listDir(dir);
  const jobs: LaunchdJob[] = [];
  for (const label of parseLaunchctlList(listed)) {
    if (!label.startsWith('ai.ashlr.') && !label.startsWith('com.ashlr.')) continue;
    jobs.push(defaultLaunchdJob(
      label,
      host.statMtime(join(dir, `${label}.plist`)),
      newestRollbackMtime(host, label, names),
      journal.get(label) ?? [],
    ));
  }
  return jobs;
}

function readJournal(text: string | null): Map<string, RunsSample[]> {
  const out = new Map<string, RunsSample[]>();
  const rows = parseJsonlRecords(text, (row): { label: string; sample: RunsSample } | null => {
    if (!isAutofixRecord(row) || typeof row.label !== 'string'
      || typeof row.atMs !== 'number' || typeof row.runs !== 'number') return null;
    return {
      label: row.label,
      sample: {
        atMs: row.atMs,
        runs: row.runs,
        lastExitCode: typeof row.lastExitCode === 'number' ? row.lastExitCode : null,
        pid: typeof row.pid === 'number' ? row.pid : null,
      },
    };
  });
  for (const { label, sample } of rows) {
    const list = out.get(label) ?? [];
    list.push(sample);
    out.set(label, list);
  }
  return out;
}

function collectLoad(host: AutofixHost): { load1: number | null; ncpu: number | null; processes: Proc[] } {
  const procLoad = host.readText('/proc/loadavg');
  let load1 = procLoad ? Number(procLoad.split(/\s+/)[0]) : Number.NaN;
  if (!Number.isFinite(load1)) {
    const sysctl = execText(host, ['sysctl', '-n', 'vm.loadavg']);
    const match = sysctl ? /([0-9]+(?:\.[0-9]+)?)/.exec(sysctl) : null;
    load1 = match ? Number(match[1]) : Number.NaN;
  }
  const cpuinfo = host.readText('/proc/cpuinfo');
  let ncpu = cpuinfo ? (cpuinfo.match(/^processor\s*:/gm) ?? []).length : 0;
  if (ncpu < 1) {
    const counted = execText(host, ['sysctl', '-n', 'hw.ncpu']);
    ncpu = counted && /^\d+$/.test(counted.trim()) ? Number(counted.trim()) : 0;
  }
  const ps = execText(host, ['ps', '-axo', 'pid=,ppid=,uid=,nice=,comm=']);
  return {
    load1: Number.isFinite(load1) ? load1 : null,
    ncpu: ncpu > 0 ? ncpu : null,
    processes: ps ? markDispatchdOwned(parsePs(ps)) : [],
  };
}

function collectLanes(host: AutofixHost): AutofixSnapshot['lanes'] {
  const text = host.readText(join(host.runsDir(), 'autofix', 'lanes.json'));
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed as AutofixSnapshot['lanes'] : [];
  } catch { return []; }
}

function parsePs(text: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)/.exec(line);
    if (!match) continue;
    procs.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      uid: Number(match[3]),
      nice: Number(match[4]),
      comm: match[5]!,
      dispatchdOwned: false,
    });
  }
  return procs;
}

function markDispatchdOwned(procs: readonly Proc[]): Proc[] {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const owned = (pid: number, depth: number): boolean => {
    if (depth > 8) return false;
    const proc = byPid.get(pid);
    if (!proc) return false;
    if (isDispatchdBinary(proc.comm)) return true;
    if (proc.ppid === pid || proc.ppid <= 0) return false;
    return owned(proc.ppid, depth + 1);
  };
  return procs.map((proc) => ({ ...proc, dispatchdOwned: owned(proc.pid, 0) }));
}

const PIN_MIRRORS: Record<string, string> = {
  'dispatchd.py': 'contrib/mac/dispatchd.py',
  'publish.sh': 'contrib/mac/publish.sh',
  'release-autorun.sh': 'contrib/mac/release-autorun.sh',
  'launch.sh': 'contrib/mac/host-integration/launch.candidate.sh',
};

function collectPinned(host: AutofixHost): AutofixSnapshot['pinned'] {
  const bin = join(host.runsDir(), 'bin');
  const repo = fileURLToPath(new URL('../../..', import.meta.url));
  const files = [];
  for (const name of PINNED_NAMES) {
    const installedPath = join(bin, name);
    const installed = host.readText(installedPath);
    const mirror = PIN_MIRRORS[name];
    const expected = mirror ? host.readText(join(repo, mirror)) : null;
    files.push({
      name,
      installedPath,
      installedSha256: installed === null ? null : sha256Hex(installed),
      expectedSha256: expected === null ? null : sha256Hex(expected),
    });
  }
  for (const name of host.listDir(bin)) {
    if (!isSandboxProfileName(name)) continue;
    const installedPath = join(bin, name);
    const installed = host.readText(installedPath);
    files.push({
      name, installedPath,
      installedSha256: installed === null ? null : sha256Hex(installed),
      expectedSha256: null,
    });
  }
  return files;
}
