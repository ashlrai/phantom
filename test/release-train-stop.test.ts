import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  autorunOffPath,
  pauseReleaseTrainForStop,
  readHostedReleaseTrainPause,
  releaseTrainStopRecordPath,
  resumeReleaseTrainAfterStop,
  RELEASE_TRAIN_STOP_SCHEMA,
  type ReleaseTrainStopGhRunner,
} from '../src/core/release/train.js';

const homes: string[] = [];
const newHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'release-train-stop-'));
  homes.push(home);
  return home;
};

afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fakeGh(initial: 'on' | 'off') {
  let variable = initial;
  const calls: { args: string[]; timeout: number }[] = [];
  const gh: ReleaseTrainStopGhRunner = (args, timeout) => {
    calls.push({ args, timeout });
    if (args[1] === 'get') return { status: 0, stdout: `${variable}\n` };
    if (args[1] === 'set') {
      variable = args.at(-1) === 'on' ? 'on' : 'off';
      return { status: 0, stdout: '' };
    }
    throw new Error(`unexpected gh command: ${args.join(' ')}`);
  };
  return { gh, calls, value: () => variable };
}

describe('release train stop/resume', () => {
  it('reports hosted pause with only a bounded read', () => {
    const fake = fakeGh('off');
    expect(readHostedReleaseTrainPause(fake.gh)).toBe('paused');
    expect(fake.calls).toEqual([{args: ['variable', 'get', 'PHANTOM_RELEASE_TRAIN', '-R', 'ashlrai/phantom'], timeout: 3000}]);
    expect(fake.value()).toBe('off');
    expect(readHostedReleaseTrainPause(() => ({status: 1, stdout: 'off'}))).toBe('unknown');
  });
  it('restores the hosted variable when pause found it on', () => {
    const home = newHome();
    const fake = fakeGh('on');
    const now = () => new Date('2026-11-25T12:00:00.000Z');
    pauseReleaseTrainForStop({ home, gh: fake.gh, now, log: () => undefined });

    expect(readFileSync(autorunOffPath(home), 'utf8')).toBe('release train off (fleet-stop)\n');
    const recordPath = releaseTrainStopRecordPath(home);
    expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toEqual({
      schema: RELEASE_TRAIN_STOP_SCHEMA, at: now().toISOString(), variableWasOn: true,
    });
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);

    resumeReleaseTrainAfterStop({ home, gh: fake.gh, log: () => undefined });
    expect(fake.value()).toBe('on');
    expect(existsSync(autorunOffPath(home))).toBe(false);
    expect(existsSync(recordPath)).toBe(false);
    expect(fake.calls.map(({ args }) => args)).toEqual([
      ['variable', 'get', 'PHANTOM_RELEASE_TRAIN', '-R', 'ashlrai/phantom'],
      ['variable', 'set', 'PHANTOM_RELEASE_TRAIN', '-R', 'ashlrai/phantom', '--body', 'off'],
      ['variable', 'set', 'PHANTOM_RELEASE_TRAIN', '-R', 'ashlrai/phantom', '--body', 'on'],
    ]);
    expect(fake.calls.every(({ timeout }) => timeout === 15_000)).toBe(true);
  });

  it('still pauses when the existing provenance record is invalid and does not restore on resume', () => {
    const home = newHome();
    mkdirSync(join(home, '.ashlr-runs'), { recursive: true });
    writeFileSync(releaseTrainStopRecordPath(home), JSON.stringify({
      schema: 'invalid',
      at: '2026-11-25T12:00:00.000Z',
      variableWasOn: true,
    }));
    const fake = fakeGh('on');
    const logs: string[] = [];

    pauseReleaseTrainForStop({ home, gh: fake.gh, log: (line) => logs.push(line) });
    expect(fake.value()).toBe('off');
    expect(logs).toContain('release train stop provenance was not recorded');

    resumeReleaseTrainAfterStop({ home, gh: fake.gh, log: (line) => logs.push(line) });
    expect(fake.value()).toBe('off');
    expect(fake.calls.map(({ args }) => args[1])).toEqual(['get', 'set']);
    expect(existsSync(releaseTrainStopRecordPath(home))).toBe(false);
    expect(existsSync(autorunOffPath(home))).toBe(false);
  });

  it('leaves the hosted variable off when pause found it off', () => {
    const home = newHome();
    const fake = fakeGh('off');
    pauseReleaseTrainForStop({ home, gh: fake.gh, log: () => undefined });
    resumeReleaseTrainAfterStop({ home, gh: fake.gh, log: () => undefined });

    expect(fake.value()).toBe('off');
    expect(fake.calls.map(({ args }) => args[1])).toEqual(['get', 'set']);
    expect(existsSync(autorunOffPath(home))).toBe(false);
  });

  it('preserves a pre-existing manual OFF file and tells the operator', () => {
    const home = newHome();
    mkdirSync(join(home, '.ashlr-runs'), { recursive: true });
    const manualOff = 'release train off\n';
    writeFileSync(autorunOffPath(home), manualOff);
    const fake = fakeGh('on');
    const logs: string[] = [];
    pauseReleaseTrainForStop({ home, gh: fake.gh, log: () => undefined });
    resumeReleaseTrainAfterStop({ home, gh: fake.gh, log: (line) => logs.push(line) });

    expect(readFileSync(autorunOffPath(home), 'utf8')).toBe(manualOff);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('delete it if the hold is not intentional');
    expect(fake.value()).toBe('on');
  });

  it('does not throw when restoring the GitHub variable fails', () => {
    const home = newHome();
    const fake = fakeGh('on');
    pauseReleaseTrainForStop({ home, gh: fake.gh, log: () => undefined });
    const logs: string[] = [];
    const failOnRestore: ReleaseTrainStopGhRunner = (args, timeout) => {
      if (args[1] === 'set' && args.at(-1) === 'on') throw new Error('gh unavailable');
      return fake.gh(args, timeout);
    };

    expect(() => resumeReleaseTrainAfterStop({ home, gh: failOnRestore, log: (line) => logs.push(line) })).not.toThrow();
    expect(logs).toContain('PHANTOM_RELEASE_TRAIN was not set on');
    expect(existsSync(releaseTrainStopRecordPath(home))).toBe(false);
    expect(existsSync(autorunOffPath(home))).toBe(false);
  });

  it('does nothing when no stop provenance record exists', () => {
    const home = newHome();
    const gh: ReleaseTrainStopGhRunner = () => { throw new Error('must not call gh'); };

    expect(() => resumeReleaseTrainAfterStop({ home, gh })).not.toThrow();
    expect(existsSync(join(home, '.ashlr-runs'))).toBe(false);
  });
});
