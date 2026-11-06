import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeDaemonStateQuarantine,
  executeDaemonStateResolution,
  prepareDaemonStateAtomicQuarantineEvidence,
  previewDaemonStateQuarantine,
  previewDaemonStateResolution,
} from '../src/core/daemon/state-recovery.js';
import { daemonStatePath, freshDaemonState, loadDaemonStateStrict } from '../src/core/daemon/state.js';
import type { ServiceStatusResult } from '../src/core/daemon/service.js';

const observedNow = new Date('2026-08-10T12:00:00.000Z');
const quarantineId = '11111111-1111-4111-8111-111111111111';
const resolutionId = '33333333-3333-4333-8333-333333333333';
let home: string | undefined;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe.runIf(process.platform !== 'win32')('daemon state resolution clock isolation', () => {
  it.each(['2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z'])(
    // Real fsync and ACL checks need the same allowance as the recovery lane.
    'uses the observed recovery day with host clock %s', { timeout: 60_000 }, (hostTime) => {
      home = mkdtempSync(join(tmpdir(), 'ashlr-resolution-clock-'));
      chmodSync(home, 0o700);
      vi.stubEnv('HOME', home);
      vi.stubEnv('USERPROFILE', home);
      vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
      // Leave I/O and lifecycle timers real. Only the ambient Date is adversarial.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(hostTime));
      const serviceStatus = (): ServiceStatusResult => ({
        registrationState: 'absent', installed: false, running: false,
        runtimeState: 'stopped', platformSpec: 'launchd',
      });
      const runtime = { now: () => observedNow, serviceStatus };
      const source = Buffer.from(JSON.stringify({
        ...freshDaemonState(), todayDate: '2026-08-10', todaySpentUsd: 8.5,
        spendGuardAccounting: { unexpected: true },
      }));
      mkdirSync(dirname(daemonStatePath()), { recursive: true, mode: 0o700 });
      writeFileSync(daemonStatePath(), source, { mode: 0o600 });
      const quarantineRuntime = {
        ...runtime, randomId: () => quarantineId,
        prepareAtomicQuarantineEvidence: prepareDaemonStateAtomicQuarantineEvidence,
      };
      const quarantine = previewDaemonStateQuarantine(
        createHash('sha256').update(source).digest('hex'), quarantineRuntime,
      );
      expect(quarantine.ok).toBe(true);
      if (!quarantine.ok) throw new Error(quarantine.detail);
      const quarantined = executeDaemonStateQuarantine({
        planId: quarantine.plan.planId, planDigest: quarantine.plan.planDigest,
        operatorAuthorization: quarantine.plan.planDigest,
      }, quarantineRuntime);
      expect(quarantined.ok).toBe(true);
      if (!quarantined.ok) throw new Error(quarantined.detail);
      const resolutionRuntime = { ...runtime, randomId: () => resolutionId, dailyBudgetUsd: () => 10 };
      const preview = previewDaemonStateResolution({
        quarantinePlanId: quarantineId,
        quarantineReceiptDigest: quarantined.receipt.receiptDigest,
      }, resolutionRuntime);
      expect(preview.ok).toBe(true);
      if (!preview.ok) throw new Error(preview.detail);
      expect(preview.plan.createdAt).toBe(observedNow.toISOString());
      const resolved = executeDaemonStateResolution({
        planId: resolutionId, planDigest: preview.plan.planDigest,
        operatorAuthorization: preview.plan.planDigest, operatorConfirmation: preview.plan.planDigest,
      }, resolutionRuntime);
      expect(resolved.ok).toBe(true);
      expect(loadDaemonStateStrict()).toEqual({
        ok: true, fresh: false, state: {
          ...freshDaemonState(), todayDate: '2026-08-10', todaySpentUsd: 10,
          spendGuardAccounting: {
            budgetDay: '2026-08-10', accountingId: resolutionId, budgetExhausted: true,
          },
        },
      });
      expect(readFileSync(quarantined.quarantinePath)).toEqual(source);
    },
  );
});
