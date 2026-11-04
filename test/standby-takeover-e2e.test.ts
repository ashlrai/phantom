/**
 * Second-computer failover, end to end with two fake hosts and zero network.
 *
 * Host A (primary) and host B (standby) are two temp dirs; the "coordinator"
 * is a shared temp dir holding the fenced lease database and the injected
 * coordinator clock (HOST_LEASE_CLOCK_FILE, the seam host_lease.py documents
 * for exactly this purpose). Every step drives the real shipped modules —
 * host_lease.py, snapshot_publish.py, snapshot_relay.py, standby_readiness.py
 * and state_snapshot.py — through their real script argv, the same vector a
 * second host would use over trusted SSH. Nothing is stubbed except time and
 * the SSH transport itself.
 *
 * Proves Mason's Nov 1 18:09 order: A holds leadership and heartbeats; B
 * stays standby; A goes silent; B waits out the primary grace, takes the
 * fenced lease and records why; B restores and reads A's last published queue
 * state; A returns and cannot grab leadership back while B's lease is fresh;
 * B releases and A leads again. Exactly one leader holds the role at every
 * observed step.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const BRIDGE = fileURLToPath(new URL('../scripts/mac-bridge/', import.meta.url));

const ROLE = 'fleet-leader';
const TTL_SEC = 30;
const GRACE_SEC = 10;
const PY_TIMEOUT_MS = 30_000;

/** Every allow-listed path state_snapshot.py stages; all must exist or the snapshot is "incomplete". */
const FLEET_FILES: Record<string, string> = {
  'queue/router-queue.md': '# router queue\n',
  'queue/ready.tsv': 'job-001\tqueued\ttest.ts\njob-002\tqueued\tfix.ts\njob-003\tqueued\tship.ts\n',
  'queue/slots.json': '{"slots":[]}\n',
  'leader/VISION.md': 'fleet vision v1\n',
  'leader/ORCHESTRATION.md': 'orchestration notes\n',
  'metrics/jobs.jsonl': '{"job":"job-001","event":"queued"}\n',
};

interface ProcResult {
  status: number | null;
  lines: Array<Record<string, unknown>>;
  stderr: string;
}

interface Hosts {
  base: string;
  clockFile: string;
  db: string;
  aFleet: string;
  aStore: string;
  bStore: string;
  bRestore: string;
  bRecord: string;
}

/** One real script call: spawnSync so expected lease denials (exit 1 + JSON) are data, not throws. */
function py(hosts: Hosts, script: string, argv: readonly string[]): ProcResult {
  const proc = spawnSync('python3', ['-B', join(BRIDGE, script), ...argv], {
    encoding: 'utf8',
    timeout: PY_TIMEOUT_MS,
    env: { ...process.env, HOST_LEASE_CLOCK_FILE: hosts.clockFile, NO_COLOR: '1' },
  });
  expect(proc.error).toBeUndefined();
  const lines = (proc.stdout ?? '').split('\n').filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { status: proc.status, lines, stderr: proc.stderr ?? '' };
}

function lease(hosts: Hosts, action: string, host: string, extra: readonly string[] = []): Record<string, unknown> {
  const base = ['--db', hosts.db, action, ROLE, '--host', host];
  const acquire = action === 'acquire'
    ? ['--ttl', String(TTL_SEC), '--primary', 'host-a', '--grace', String(GRACE_SEC)]
    : [];
  const result = py(hosts, 'host_lease.py', [...base, ...acquire, ...extra]);
  expect(result.lines).toHaveLength(1);
  return result.lines[0]!;
}

function leaseStatus(hosts: Hosts): Record<string, unknown> {
  const result = py(hosts, 'host_lease.py', ['--db', hosts.db, 'status', ROLE]);
  expect(result.lines).toHaveLength(1);
  return result.lines[0]!;
}

/** The current lease holder, or null when the role is free. Fails the test on a malformed status. */
function leader(hosts: Hosts): string | null {
  const status = leaseStatus(hosts);
  expect(status.ok).toBe(true);
  const holder = status.holder;
  expect(holder === null || typeof holder === 'string').toBe(true);
  return holder as string | null;
}

function makeHosts(): Hosts {
  const base = mkdtempSync(join(tmpdir(), 'standby-takeover-e2e-'));
  const shared = join(base, 'shared');           // coordinator: lease DB + injected clock
  const hostA = join(base, 'host-a');            // primary's own disk
  const hostB = join(base, 'host-b');            // standby's own disk
  const hosts: Hosts = {
    base,
    clockFile: join(shared, 'coordinator.clock'),
    db: join(shared, 'lease.sqlite'),
    aFleet: join(hostA, 'fleet-state'),
    aStore: join(hostA, 'snapshots'),
    bStore: join(hostB, 'snapshots'),
    bRestore: join(hostB, 'restore'),
    bRecord: join(hostB, 'takeover.json'),
  };
  mkdirSync(shared, { recursive: true });
  mkdirSync(hosts.aStore, { recursive: true });
  mkdirSync(hosts.bStore, { recursive: true });
  mkdirSync(hosts.bRestore, { recursive: true });
  for (const [rel, text] of Object.entries(FLEET_FILES)) {
    const path = join(hosts.aFleet, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  // The injected coordinator clock starts at real time so snapshot ages are honest.
  writeFileSync(hosts.clockFile, String(Date.now() / 1000));
  return hosts;
}

describe('standby takeover e2e', () => {
  let hosts: Hosts;
  afterEach(() => { rmSync(hosts?.base ?? '', { recursive: true, force: true }); });

  it('standby takes over an expired primary, reads its queue, and hands leadership back', () => {
    hosts = makeHosts();
    const setClock = (now: number) => writeFileSync(hosts.clockFile, String(now));
    const clock = () => Number(readFileSync(hosts.clockFile, 'utf8'));

    // (a) A acquires the fenced lease and heartbeats; B checks and stays standby.
    const granted = lease(hosts, 'acquire', 'host-a');
    expect(granted).toMatchObject({ ok: true, state: 'held', holder: 'host-a', fencing: 1 });
    const aFence = granted.fencing as number;
    const renewed = lease(hosts, 'renew', 'host-a', ['--fencing', String(aFence), '--ttl', String(TTL_SEC)]);
    expect(renewed).toMatchObject({ ok: true, state: 'held', holder: 'host-a' });
    const aExpiry = renewed.expires as number;
    // A publishes its fleet state while healthy; the relay lands it on B's store.
    const published = py(hosts, 'snapshot_publish.py', ['--root', hosts.aFleet,
      '--destination', hosts.aStore, '--once', '--reserve-bytes', '0']);
    expect(published.status).toBe(0);
    expect(published.lines.at(-1)).toMatchObject({ tool: 'snapshot_publish', published: 1 });
    const relayed = py(hosts, 'snapshot_relay.py', ['--source', hosts.aStore,
      '--destination', hosts.bStore, '--apply']);
    expect(relayed.status).toBe(0);
    expect(relayed.lines[0]).toMatchObject({ ok: true, apply: true, copied: true });
    // B observes a held lease and its own acquire is refused: it stays standby.
    const denied = lease(hosts, 'acquire', 'host-b');
    expect(denied).toMatchObject({ ok: false, error: 'lease held', holder: 'host-a' });
    expect(leader(hosts)).toBe('host-a');

    // (b) A goes silent (no more renewals). Past expiry + primary grace, B takes over.
    // Inside the grace window B is still refused: a brief primary restart must not flip leadership.
    setClock(aExpiry + 1);
    expect(lease(hosts, 'acquire', 'host-b'))
      .toMatchObject({ ok: false, error: 'within primary grace', holder: 'host-a' });
    expect(leader(hosts)).toBe('host-a');
    setClock(aExpiry + GRACE_SEC + 1);
    const seen = leaseStatus(hosts);
    expect(seen).toMatchObject({ ok: true, state: 'expired', holder: 'host-a' });
    // B's readiness probe (the CLI/API verdict): snapshot complete and verified, holder still A.
    const ready = py(hosts, 'standby_readiness.py', ['--db', hosts.db,
      '--snapshot-store', hosts.bStore, '--primary', 'host-a', '--role', ROLE, '--host', 'host-b']);
    expect(ready.status).toBe(0);
    expect(ready.lines[0]).toMatchObject({ ready: true, blockers: [], leaseHolder: 'host-a' });
    expect(ready.lines[0]!.leaseExpiresInSec as number).toBeLessThan(0);
    expect(ready.lines[0]!.snapshotAgeSec as number).toBeGreaterThanOrEqual(GRACE_SEC);
    const generation = ready.lines[0]!.generation as string;
    expect(generation).toMatch(/^snap-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
    // B takes the fenced lease and records why on its own disk.
    const taken = lease(hosts, 'acquire', 'host-b');
    expect(taken).toMatchObject({ ok: true, state: 'held', holder: 'host-b', fencing: aFence + 1 });
    const bFence = taken.fencing as number;
    writeFileSync(hosts.bRecord, JSON.stringify({
      v: 1, at: clock(), reason: 'primary lease expired', role: ROLE,
      previousHolder: seen.holder, fencing: bFence, generation,
    }));
    expect(leader(hosts)).toBe('host-b');

    // (c) B restores A's last published snapshot and reads the same queued job lines.
    const restored = py(hosts, 'state_snapshot.py', ['restore',
      join(hosts.bStore, generation), '--root', hosts.bRestore, '--apply']);
    expect(restored.status).toBe(0);
    expect(restored.lines[0]).toMatchObject({ ok: true, applied: true });
    const queuedLines = (root: string) => readFileSync(join(root, 'queue/ready.tsv'), 'utf8')
      .split('\n').filter((l) => l !== '').sort();
    expect(queuedLines(hosts.bRestore)).toEqual(queuedLines(hosts.aFleet));
    const record = JSON.parse(readFileSync(hosts.bRecord, 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({ reason: 'primary lease expired', previousHolder: 'host-a', fencing: bFence });

    // (d) A returns mid-lease. It sees B leading and cannot take leadership back.
    const comeback = lease(hosts, 'acquire', 'host-a');
    expect(comeback).toMatchObject({ ok: false, error: 'lease held', holder: 'host-b' });
    const bRenewed = lease(hosts, 'renew', 'host-b', ['--fencing', String(bFence), '--ttl', String(TTL_SEC)]);
    expect(bRenewed).toMatchObject({ ok: true, state: 'held', holder: 'host-b' });
    expect(leader(hosts)).toBe('host-b');

    // (e) B releases cleanly; A takes leadership again with a higher fence.
    const released = lease(hosts, 'release', 'host-b', ['--fencing', String(bFence)]);
    expect(released).toMatchObject({ ok: true, state: 'free', holder: null });
    const regained = lease(hosts, 'acquire', 'host-a');
    expect(regained).toMatchObject({ ok: true, state: 'held', holder: 'host-a' });
    expect(regained.fencing as number).toBeGreaterThan(bFence);
    // Back to one leader; B's acquire is refused again — the standby posture holds.
    expect(lease(hosts, 'acquire', 'host-b')).toMatchObject({ ok: false, error: 'lease held', holder: 'host-a' });
    expect(leader(hosts)).toBe('host-a');
  });
});
