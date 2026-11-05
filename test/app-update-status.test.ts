import {describe, expect, spyOn, test} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cmdApp, readAppUpdateStatus, type AppUpdateStatusDependencies} from '../src/cli/app.js';

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
      const output = spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(await cmdApp(['update', 'status', '--json'], deps)).toBe(0);
        expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(readAppUpdateStatus(deps));
      } finally {output.mockRestore();}
    } finally {rmSync(home, {recursive: true, force: true});}
  });
});
