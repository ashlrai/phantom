/**
 * Read-only guard health diagnosis for daemon/autonomy repair UX.
 *
 * This module reports safety guards that explain why autonomous work is blocked
 * or likely to fail closed. It never repairs or probes by writing files.
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { probeDaemonLiveness, type DaemonLivenessV1 } from './liveness.js';
import { readDaemonPause } from './pause.js';

import { evidenceDir } from '../autonomy/evidence-pack.js';
import { readKillSwitch } from '../sandbox/policy.js';
import { daemonLockPath, loadDaemonStateStrict, readDaemonLockOwner, readDaemonSpendGuard } from './state.js';

export type GuardHealthBlockId =
  | 'daemon-state-malformed'
  | 'daemon-spend-guard-armed'
  | 'daemon-spend-guard-dead-owner'
  | 'daemon-spend-guard-stale-live-owner'
  | 'daemon-spend-guard-malformed'
  | 'kill-switch'
  | 'kill-switch-uninspectable'
  | 'autonomy-evidence-unwritable';

export interface GuardHealthBlock {
  id: GuardHealthBlockId;
  detail: string;
  path: string;
  repairCommands: string[];
}

export interface GuardHealthDiagnosis {
  generatedAt: string;
  blocked: boolean;
  blocks: GuardHealthBlock[];
  sourceQuality?: {
    sourceState: 'healthy' | 'degraded';
    complete: boolean;
    reasons: string[];
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function backupCommand(path: string): string {
  return `mv ${shellQuote(path)} ${shellQuote(`${path}.bak`)}`;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function heartbeatAgeMs(heartbeatAt: string): number | null {
  const ms = Date.parse(heartbeatAt);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Date.now() - ms);
}

function nearestExistingPath(path: string): string | null {
  let current = path;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isWritableDirectory(path: string): { ok: true } | { ok: false; detail: string; repairCommands: string[] } {
  try {
    if (existsSync(path)) {
      const st = statSync(path);
      if (!st.isDirectory()) {
        return {
          ok: false,
          detail: 'autonomy evidence path exists but is not a directory',
          repairCommands: [backupCommand(path), `mkdir -p ${shellQuote(path)}`],
        };
      }
      accessSync(path, constants.W_OK | constants.X_OK);
      return { ok: true };
    }

    const parent = nearestExistingPath(dirname(path));
    if (!parent) {
      return {
        ok: false,
        detail: 'no existing parent directory for autonomy evidence path',
        repairCommands: [`mkdir -p ${shellQuote(path)}`],
      };
    }
    const st = statSync(parent);
    if (!st.isDirectory()) {
      return {
        ok: false,
        detail: `autonomy evidence parent is not a directory: ${parent}`,
        repairCommands: [backupCommand(parent), `mkdir -p ${shellQuote(path)}`],
      };
    }
    accessSync(parent, constants.W_OK | constants.X_OK);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      detail: `autonomy evidence path is not writable: ${msg}`,
      repairCommands: [`mkdir -p ${shellQuote(path)}`, `chmod u+rwx ${shellQuote(path)}`],
    };
  }
}

function fallbackDiagnosis(generatedAt: string, err: unknown): GuardHealthDiagnosis {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    generatedAt,
    blocked: true,
    blocks: [
      {
        id: 'daemon-state-malformed',
        detail: `guard health diagnosis failed closed: ${msg}`,
        path: '',
        repairCommands: ['ashlr doctor'],
      },
    ],
    sourceQuality: {
      sourceState: 'degraded',
      complete: false,
      reasons: ['diagnosis-failed'],
    },
  };
}

/**
 * Diagnose daemon/autonomy guard state. Never mutates and never throws.
 */
export function diagnoseGuardHealth(): GuardHealthDiagnosis {
  const generatedAt = new Date().toISOString();
  try {
    const blocks: GuardHealthBlock[] = [];
    const sourceReasons: string[] = [];

    const daemonState = loadDaemonStateStrict();
    if (!daemonState.ok) {
      sourceReasons.push(`daemon-state-${daemonState.reason}`);
      blocks.push({
        id: 'daemon-state-malformed',
        detail:
          `daemon state is ${daemonState.reason}: ${daemonState.error}; ` +
          `issues=${daemonState.diagnostic.issueCodes.join(',')}; ` +
          'automatic repair and mutation authority remain withheld',
        path: daemonState.path,
        repairCommands: ['ashlr daemon status --json', 'ashlr daemon service-status --json'],
      });
    }

    const spendGuard = readDaemonSpendGuard();
    if (spendGuard.exists) {
      if (spendGuard.malformed || !spendGuard.guard) {
        blocks.push({
          id: 'daemon-spend-guard-malformed',
          detail: spendGuard.error
            ? `daemon spend guard is malformed or unreadable: ${spendGuard.error}`
            : 'daemon spend guard is malformed',
          path: spendGuard.path,
          repairCommands: ['ashlr daemon stop', backupCommand(spendGuard.path), 'ashlr daemon status'],
        });
      } else if (!pidIsAlive(spendGuard.guard.pid)) {
        blocks.push({
          id: 'daemon-spend-guard-dead-owner',
          detail:
            `daemon spend guard owner pid ${spendGuard.guard.pid} is not running; ` +
            `guard was armed at ${spendGuard.guard.armedAt} for ${spendGuard.guard.itemIds.length} item(s)`,
          path: spendGuard.path,
          repairCommands: ['ashlr daemon stop', backupCommand(spendGuard.path), 'ashlr daemon status'],
        });
      } else if (
        !(
          daemonState.ok &&
          daemonState.state.running === true &&
          daemonState.state.pid === spendGuard.guard.pid
        )
      ) {
        blocks.push({
          id: 'daemon-spend-guard-armed',
          detail: `daemon spend guard armed at ${spendGuard.guard.armedAt} for ${spendGuard.guard.itemIds.length} item(s)`,
          path: spendGuard.path,
          repairCommands: ['ashlr daemon stop', backupCommand(spendGuard.path), 'ashlr daemon status'],
        });
      } else {
        const lockOwner = readDaemonLockOwner();
        const lockAge = lockOwner?.pid === spendGuard.guard.pid ? heartbeatAgeMs(lockOwner.heartbeatAt) : null;
        // The daemon refreshes its lock every 30s. Missing several pulses while
        // a spend guard is armed means in-flight accounting may be wedged.
        const staleLiveOwnerMs = 2 * 60_000;
        if (!lockOwner || lockOwner.pid !== spendGuard.guard.pid || lockAge === null) {
          blocks.push({
            id: 'daemon-spend-guard-stale-live-owner',
            detail:
              `daemon spend guard is owned by live pid ${spendGuard.guard.pid}, ` +
              'but no matching daemon lock heartbeat is present',
            path: daemonLockPath(),
            repairCommands: ['ashlr daemon stop', backupCommand(spendGuard.path), 'ashlr daemon status'],
          });
        } else if (lockAge >= staleLiveOwnerMs) {
          blocks.push({
            id: 'daemon-spend-guard-stale-live-owner',
            detail:
              `daemon spend guard is owned by live pid ${spendGuard.guard.pid}, ` +
              `but daemon lock heartbeat is stale (${Math.round(lockAge / 1000)}s old)`,
            path: daemonLockPath(),
            repairCommands: ['ashlr daemon stop', backupCommand(spendGuard.path), 'ashlr daemon status'],
          });
        }
      }
    }

    const killSwitch = readKillSwitch();
    if (killSwitch.state === 'active') {
      blocks.push({
        id: 'kill-switch',
        detail: 'global kill switch is engaged; autonomous dispatch is paused',
        path: killSwitch.path,
        repairCommands: ['ashlr fleet resume'],
      });
    } else if (killSwitch.state === 'unknown') {
      sourceReasons.push('kill-switch-uninspectable');
      blocks.push({
        id: 'kill-switch-uninspectable',
        detail: 'global kill switch state cannot be inspected; autonomous dispatch remains paused',
        path: killSwitch.path,
        repairCommands: ['ashlr daemon status', 'ashlr doctor'],
      });
    }

    const evidencePath = evidenceDir();
    const evidence = isWritableDirectory(evidencePath);
    if (!evidence.ok) {
      blocks.push({
        id: 'autonomy-evidence-unwritable',
        detail: evidence.detail,
        path: evidencePath,
        repairCommands: evidence.repairCommands,
      });
    }

    return {
      generatedAt,
      blocked: blocks.length > 0,
      blocks,
      sourceQuality: {
        sourceState: sourceReasons.length > 0 ? 'degraded' : 'healthy',
        complete: sourceReasons.length === 0,
        reasons: sourceReasons.slice(0, 8),
      },
    };
  } catch (err) {
    return fallbackDiagnosis(generatedAt, err);
  }
}

export const DAEMON_LOG_STALE_MS = 15 * 60_000;

export interface DaemonHealthClient {
  id: string;
  engine: string;
  model: string | null;
}

export interface DaemonHealthDeps {
  nowMs?: number;
  liveness?: () => DaemonLivenessV1;
  pause?: () => 'paused' | 'running' | 'unknown';
  kill?: () => 'active' | 'inactive' | 'unknown';
  /** null means absent; undefined means unreadable or unsafe metadata. */
  logMtime?: (name: string) => number | null | undefined;
  platform?: NodeJS.Platform;
}

export interface DaemonHealth {
  schemaVersion: 1;
  checkedAt: string;
  alive: boolean | null;
  pid: number | null;
  lastTickAt: string | null;
  lastLogWriteAt: string | null;
  logAgeMs: number | null;
  logState: 'fresh' | 'stale' | 'missing' | 'unknown';
  frontierClientsResolved: DaemonHealthClient[] | null;
  paused: boolean | null;
  killed: boolean | null;
  healthy: boolean;
  supervisor: {
    restartRecommended: boolean;
    reason: 'healthy' | 'dead' | 'log-stale' | 'paused' | 'killed' | 'unknown' | 'logs-missing' | 'frontier-unavailable';
  };
}

function readLogMtime(name: string): number | null | undefined {
  try {
    // Observe metadata only. Never read daemon log content or provider auth files.
    const metadata = statSync(join(homedir(), '.ashlr', name));
    return metadata.isFile() ? metadata.mtimeMs : undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

/** This recommendation grants no activation authority and performs no restart. */
export function readDaemonHealth(
  frontierClientsResolved: DaemonHealthClient[] | null,
  deps: DaemonHealthDeps = {},
): DaemonHealth {
  const nowMs = deps.nowMs ?? Date.now();
  const live = (deps.liveness ?? probeDaemonLiveness)();
  const pause = (deps.pause ?? (() => readDaemonPause().state))();
  const kill = (deps.kill ?? (() => readKillSwitch().state))();
  const logMtime = deps.logMtime ?? readLogMtime;
  const names = (deps.platform ?? process.platform) === 'darwin'
    ? ['daemon.launchd.out.log', 'daemon.launchd.err.log']
    : ['daemon.systemd.log'];
  const times = names.map(logMtime);
  const unknown = times.some((time) => time === undefined ||
    (time !== null && (!Number.isFinite(time) || time < 0 || time > nowMs)));
  const observed = times.filter((time): time is number => typeof time === 'number' &&
    Number.isFinite(time) && time >= 0 && time <= nowMs);
  const latest = observed.length > 0 ? Math.max(...observed) : null;
  const logAgeMs = latest === null ? null : nowMs - latest;
  const logState = unknown ? 'unknown' : logAgeMs === null ? 'missing'
    : logAgeMs > DAEMON_LOG_STALE_MS ? 'stale' : 'fresh';
  // A dead process may be intentionally stopped. Never recommend a restart
  // across a pause, Stop, or an unreadable control/liveness observation.
  const reason: DaemonHealth['supervisor']['reason'] = kill === 'active' ? 'killed'
    : pause === 'paused' ? 'paused'
      : kill === 'unknown' || pause === 'unknown' || live.alive === null ? 'unknown'
        : live.alive === false ? 'dead'
          : logState === 'stale' ? 'log-stale'
            : logState === 'missing' ? 'logs-missing'
              : logState === 'unknown' || frontierClientsResolved === null ? 'unknown'
                : frontierClientsResolved.length === 0 ? 'frontier-unavailable' : 'healthy';
  return {
    schemaVersion: 1,
    checkedAt: new Date(nowMs).toISOString(),
    alive: live.alive,
    pid: live.pid,
    lastTickAt: live.recorded.lastTickAt,
    lastLogWriteAt: latest === null ? null : new Date(latest).toISOString(),
    logAgeMs,
    logState,
    frontierClientsResolved,
    paused: pause === 'unknown' ? null : pause === 'paused',
    killed: kill === 'unknown' ? null : kill === 'active',
    healthy: live.alive === true && logState === 'fresh' && pause === 'running' &&
      kill === 'inactive' && frontierClientsResolved !== null && frontierClientsResolved.length > 0,
    supervisor: { restartRecommended: reason === 'dead' || reason === 'log-stale', reason },
  };
}
