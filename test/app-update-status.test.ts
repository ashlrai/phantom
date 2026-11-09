import {describe, expect, vi, test} from 'vitest';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cmdApp, readAppUpdateStatus, type AppUpdateStatusDependencies} from '../src/cli/app.js';
import {bundleVersionFromPlist} from '../src/core/app-update-status.js';

describe('app update status', () => {
  test('missing, unsafe, and malformed pointers cannot request host inspection', () => {
    const home = mkdtempSync(join(tmpdir(), 'app-update-'));
    let calls = 0;
    const deps: AppUpdateStatusDependencies = {home, inspect() {calls++; throw new Error('must not inspect');}};
    try {
      expect(readAppUpdateStatus(deps).deferredReason).toBe('native-status-unavailable');
      mkdirSync(join(home, '.ashlr'), {mode: 0o700});
      mkdirSync(join(home, '.ashlr/updates'), {mode: 0o700});
      const pointer = join(home, '.ashlr/updates/native-stage.json');
      writeFileSync(pointer, JSON.stringify({stageId: '../escape'}), {mode: 0o600});
      expect(readAppUpdateStatus(deps).available).toBeNull();
      rmSync(pointer);
      symlinkSync('/dev/null', pointer);
      expect(readAppUpdateStatus(deps).deferredReason).toBe('native-status-unavailable');
      expect(calls).toBe(0);
    } finally {rmSync(home, {recursive: true, force: true});}
  });
  test('reports verified candidate and host hold without inventing app or job identity', async () => {
    const home = mkdtempSync(join(tmpdir(), 'app-update-'));
    mkdirSync(join(home, '.ashlr'), {mode: 0o700});
    mkdirSync(join(home, '.ashlr/updates'), {mode: 0o700});
    const stageId = 'a'.repeat(32);
    writeFileSync(join(home, '.ashlr/updates/native-stage.json'), JSON.stringify({stageId}), {mode: 0o600});
    const deps: AppUpdateStatusDependencies = {home, inspect(stage) {
      expect(stage).toBe(stageId);
      return {result: {schema: 'phantom-desktop-update-result/v1', state: 'blocked', version: '3.31.0', reason: 'work-active-or-unknown', requiresReapproval: false}, runningJobCount: 2, unknownJobs: 1};
    }};
    try {
      expect(readAppUpdateStatus(deps)).toEqual({current: null, available: '3.31.0', deferredReason: 'work-active-or-unknown', runningJobs: null, runningJobCount: 2, unknownJobs: 1});
      expect(await cmdApp(['update', 'status', '--apply'], deps)).toBe(2);
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(await cmdApp(['update', 'status', '--json'], deps)).toBe(0);
        expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(readAppUpdateStatus(deps));
      } finally {output.mockRestore();}
    } finally {rmSync(home, {recursive: true, force: true});}
  });

  function homeWithStage(version: string | null): {home: string; deps: AppUpdateStatusDependencies; calls: number} {
    const home = mkdtempSync(join(tmpdir(), 'app-update-'));
    mkdirSync(join(home, '.ashlr'), {mode: 0o700});
    mkdirSync(join(home, '.ashlr/updates'), {mode: 0o700});
    if (version !== null) writeFileSync(join(home, '.ashlr/updates/native-stage.json'), JSON.stringify({stageId: 'b'.repeat(32)}), {mode: 0o600});
    let calls = 0;
    const deps: AppUpdateStatusDependencies = {
      home,
      installedVersion: () => '3.30.24',
      inspect() {
        calls++;
        return {result: {schema: 'phantom-desktop-update-result/v1', state: 'ready', version, reason: 'staged', requiresReapproval: false}, runningJobCount: 0, unknownJobs: 0};
      },
    };
    return {home, deps, get calls() { return calls; }};
  }

  test('a missing stage still reports the installed bundle version', () => {
    const home = mkdtempSync(join(tmpdir(), 'app-update-'));
    let calls = 0;
    const deps: AppUpdateStatusDependencies = {home, installedVersion: () => '3.30.24', inspect() { calls++; throw new Error('must not inspect'); }};
    try {
      expect(readAppUpdateStatus(deps)).toEqual({current: '3.30.24', available: null, deferredReason: null, runningJobs: null, runningJobCount: null, unknownJobs: null});
      expect(calls).toBe(0);
      expect(bundleVersionFromPlist({CFBundleIdentifier: 'ai.ashlr.desktop', CFBundleShortVersionString: '3.30.24'})).toBe('3.30.24');
      expect(bundleVersionFromPlist({CFBundleIdentifier: 'other', CFBundleShortVersionString: '3.30.24'})).toBeNull();
    } finally {rmSync(home, {recursive: true, force: true});}
  });

  test('a stage at or below the installed version is ignored', () => {
    const lower = homeWithStage('3.29.3');
    const same = homeWithStage('3.30.24');
    try {
      expect(readAppUpdateStatus(lower.deps)).toMatchObject({current: '3.30.24', available: null, deferredReason: null});
      expect(lower.calls).toBe(1);
      expect(readAppUpdateStatus(same.deps)).toMatchObject({current: '3.30.24', available: null, deferredReason: null});
    } finally {
      rmSync(lower.home, {recursive: true, force: true});
      rmSync(same.home, {recursive: true, force: true});
    }
  });

  test('a newer stage remains the available update', () => {
    const staged = homeWithStage('3.30.28');
    try {
      expect(readAppUpdateStatus(staged.deps)).toMatchObject({current: '3.30.24', available: '3.30.28', deferredReason: 'staged'});
      expect(staged.calls).toBe(1);
    } finally {rmSync(staged.home, {recursive: true, force: true});}
  });
});
