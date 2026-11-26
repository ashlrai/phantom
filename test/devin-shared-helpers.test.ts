import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as devinCliMod from '../src/cli/devin.js';
import * as acpTerminalMod from '../src/core/devin/acp-terminal.js';
import * as chatMod from '../src/core/devin/chat.js';
import * as cliProbeMod from '../src/core/devin/cli-probe.js';
import * as cliPrsMod from '../src/core/devin/cli-prs.js';
import * as clientMod from '../src/core/devin/client.js';
import * as devinApiMod from '../src/core/devin/devin-api.js';
import * as fleetLauncherMod from '../src/core/devin/fleet-launcher.js';
import * as intakeMod from '../src/core/devin/intake.js';
import * as landMod from '../src/core/devin/land.js';
import * as modelsMod from '../src/core/devin/models.js';
import * as secretMod from '../src/core/devin/secret.js';
import * as serviceMod from '../src/core/devin/service.js';
import * as storeMod from '../src/core/devin/store.js';
import * as timelineMod from '../src/core/devin/timeline.js';
import * as trackerMod from '../src/core/devin/tracker.js';
import { scrubDevinTurnText } from '../src/core/devin/turn-protocol.js';
import {
  errorMessageText,
  formatAcu,
  isIsoTimestamp,
  isNonNegativeFiniteNumber,
  isRecord,
  isTerminalDevinTaskState,
  redactDevinKeys,
  round2,
} from '../src/core/devin/types.js';
import * as weeklyCapacityMod from '../src/core/devin/weekly-capacity.js';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'devin-shared-helpers-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('devin shared helpers', () => {
  it('validates record, ISO timestamp, non-negative finite number, and terminal task states', () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('text')).toBe(false);

    expect(isIsoTimestamp('2026-11-26T12:00:00.000Z')).toBe(true);
    expect(isIsoTimestamp('not-a-date')).toBe(false);
    expect(isIsoTimestamp(1234567890)).toBe(false);

    expect(isNonNegativeFiniteNumber(0)).toBe(true);
    expect(isNonNegativeFiniteNumber(12.5)).toBe(true);
    expect(isNonNegativeFiniteNumber(-0.1)).toBe(false);
    expect(isNonNegativeFiniteNumber(Number.NaN)).toBe(false);
    expect(isNonNegativeFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isNonNegativeFiniteNumber('1')).toBe(false);

    for (const state of ['merged', 'closed', 'failed', 'expired'] as const) {
      expect(isTerminalDevinTaskState(state)).toBe(true);
    }
    for (const state of ['queued', 'launching', 'running', 'blocked', 'pr-open'] as const) {
      expect(isTerminalDevinTaskState(state)).toBe(false);
    }
  });

  it('rounds ACU values, formats ACU labels, and extracts error messages consistently', () => {
    expect(round2(1.234)).toBe(1.23);
    expect(round2(1.236)).toBe(1.24);
    expect(round2(0)).toBe(0);

    expect(formatAcu(1)).toBe('1 ACU');
    expect(formatAcu(1.004)).toBe('1 ACU');
    expect(formatAcu(0)).toBe('0 ACUs');
    expect(formatAcu(2.345)).toBe('2.35 ACUs');

    expect(errorMessageText(new Error('boom'))).toBe('boom');
    expect(errorMessageText('plain failure')).toBe('plain failure');
    expect(errorMessageText(42)).toBe('42');
  });

  it('redacts Devin key tokens and scrubs/truncates turn text', () => {
    const syntheticKey = `${'cog'}_testToken_12345678`;
    expect(redactDevinKeys(`token=${syntheticKey}`)).toBe('token=[REDACTED]');
    expect(redactDevinKeys(`token=${syntheticKey}`, '')).toBe('token=');
    expect(redactDevinKeys('no keys here')).toBe('no keys here');

    expect(scrubDevinTurnText(`hello ${syntheticKey}`)).toBe('hello [REDACTED]');
    expect(scrubDevinTurnText('abcdef', 4)).toBe('abc…');
    expect(scrubDevinTurnText('abcd', 4)).toBe('abcd');
  });

  it('reads private JSON files safely and fails closed on invalid, oversized, missing, or symlink paths', () => {
    const validPath = join(tempDir, 'valid.json');
    writeFileSync(validPath, JSON.stringify({ ok: true, count: 3 }), { mode: 0o600 });
    expect(storeMod.readDevinJsonFile(validPath, 1024)).toEqual({ ok: true, count: 3 });

    const invalidPath = join(tempDir, 'invalid.json');
    writeFileSync(invalidPath, '{broken json', { mode: 0o600 });
    expect(storeMod.readDevinJsonFile(invalidPath, 1024)).toBeUndefined();

    const oversizedPath = join(tempDir, 'oversized.json');
    writeFileSync(oversizedPath, JSON.stringify({ pad: 'x'.repeat(256) }), { mode: 0o600 });
    expect(storeMod.readDevinJsonFile(oversizedPath, 64)).toBeUndefined();

    expect(storeMod.readDevinJsonFile(join(tempDir, 'missing.json'), 1024)).toBeUndefined();

    const linkPath = join(tempDir, 'link.json');
    symlinkSync(validPath, linkPath);
    expect(storeMod.readDevinJsonFile(linkPath, 1024)).toBeUndefined();
  });

  it('does not export pruned internal Devin helpers and constants', () => {
    expect('ACP_TERMINAL_METHODS' in acpTerminalMod).toBe(false);
    expect('callVerseTool' in acpTerminalMod).toBe(false);
    expect('DEVIN_CHAT_MESSAGE_MAX_CHARS' in chatMod).toBe(false);
    expect('emptyDevinChatState' in chatMod).toBe(false);
    expect('DEVIN_CLI_LOGIN_COMMAND' in cliProbeMod).toBe(false);
    expect('DEVIN_CLI_INSTALL_COMMAND' in cliProbeMod).toBe(false);
    expect('DEVIN_CLI_PROBE_TRUST_MS' in cliProbeMod).toBe(false);
    expect('devinCliRefusal' in cliProbeMod).toBe(false);
    expect('DEVIN_CLI_PRS_DIR' in cliPrsMod).toBe(false);
    expect('DEVIN_CLI_PRS_DISMISSED_FILE' in cliPrsMod).toBe(false);
    expect('readDevinCliChatPrs' in cliPrsMod).toBe(false);
    expect('parseDevinSessionAttachments' in clientMod).toBe(false);
    expect('parseDevinMessagePage' in clientMod).toBe(false);
    expect('VERSE_DEVIN_CONSUMPTION_REFRESH_PATH' in devinApiMod).toBe(false);
    expect('DEVIN_DISMISS_REASON' in devinApiMod).toBe(false);
    expect('DEVIN_FAILED_WINDOW_MS' in devinApiMod).toBe(false);
    expect('VERSE_DEVIN_CLI_PRS_PATH' in devinApiMod).toBe(false);
    expect('refreshDevinTasksGuarded' in devinApiMod).toBe(false);
    expect('devinSchedulerRefusal' in devinApiMod).toBe(false);
    expect('DEVIN_FLEET_AREAS' in fleetLauncherMod).toBe(false);
    expect('DEVIN_LANE_ADVICE_MIN_CONFIDENCE' in fleetLauncherMod).toBe(false);
    expect('DEVIN_LANE_ADVICE_MAX_ASKS' in fleetLauncherMod).toBe(false);
    expect('devinFleetPrompt' in fleetLauncherMod).toBe(false);
    expect('defaultDevinFleetTickDeps' in fleetLauncherMod).toBe(false);
    expect('DEVIN_INTAKE_ENGINE' in intakeMod).toBe(false);
    expect('DEVIN_LAND_REPOS' in landMod).toBe(false);
    expect('DEVIN_LAND_UPSTREAM_OWNER' in landMod).toBe(false);
    expect('DEVIN_LAND_LANE' in landMod).toBe(false);
    expect('DEVIN_LAND_TIER' in landMod).toBe(false);
    expect('DEVIN_LAND_MAX_BUNDLE_BYTES' in landMod).toBe(false);
    expect('DEVIN_LAND_MAX_PR_MD_BYTES' in landMod).toBe(false);
    expect('DEVIN_LAND_MAX_COMMITS' in landMod).toBe(false);
    expect('DEVIN_MODELS_RETRY_MS' in modelsMod).toBe(false);
    expect('DEVIN_MODELS_CACHE_FILE' in modelsMod).toBe(false);
    expect('devinDefaultModelOf' in modelsMod).toBe(false);
    expect('devinFamilyIsFree' in modelsMod).toBe(false);
    expect('devinModelsCachePath' in modelsMod).toBe(false);
    expect('SECURITY_BIN' in secretMod).toBe(false);
    expect('DevinKeyError' in secretMod).toBe(false);
    expect('defaultSecurityRunner' in secretMod).toBe(false);
    expect('isDevinApiKey' in secretMod).toBe(false);
    expect('DEVIN_TITLE_MAX_CHARS' in serviceMod).toBe(false);
    expect('devinModeOf' in serviceMod).toBe(false);
    expect('devinChatVerdict' in serviceMod).toBe(false);
    expect('devinFleetLine' in serviceMod).toBe(false);
    expect('deriveDevinTitle' in serviceMod).toBe(false);
    expect('DEVIN_DIR' in storeMod).toBe(false);
    expect('DEVIN_TASKS_DIR' in storeMod).toBe(false);
    expect('DEVIN_BUDGET_FILE' in storeMod).toBe(false);
    expect('DEVIN_CONNECTION_FILE' in storeMod).toBe(false);
    expect('DEVIN_BUDGET_LIMITS' in storeMod).toBe(false);
    expect('devinBudgetPath' in storeMod).toBe(false);
    expect('devinConnectionPath' in storeMod).toBe(false);
    expect('DEVIN_TIMELINE_WORDS' in timelineMod).toBe(false);
    expect('DEVIN_EXPIRED_WATCH_MS' in trackerMod).toBe(false);
    expect('DEVIN_STALE_LAUNCH_MS' in trackerMod).toBe(false);
    expect('DEVIN_WEEK_MS' in weeklyCapacityMod).toBe(false);
    expect('devinWeeklyCapacityPath' in weeklyCapacityMod).toBe(false);
    expect('DEVIN_PREVIEW_MODELS' in weeklyCapacityMod).toBe(false);
    expect('devinTasksToList' in devinCliMod).toBe(false);
  });
});
