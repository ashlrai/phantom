import { describe, expect, it } from 'vitest';
import { decideReload, type UpdateReloadReading } from './update-reload-model.js';

const a = 'aaaaaaa';
const b = 'bbbbbbb';
const reading = (headSha: string | null) => ({ installedVersion: '3.30.0', sourceState: 'healthy' as const, headSha });
type Reading = UpdateReloadReading & { processHeadSha?: unknown };
const decision = (first: Reading, current: Reading) => decideReload({
  first, current, appVersion: '3.30.0', chunkError: false, dismissedSha: null,
});

describe('reload after manual apply', () => {
  it('stays quiet when the disk commit changes but the process has not restarted', () => {
    expect(decision({ ...reading(a), processHeadSha: a }, { ...reading(b), processHeadSha: a }))
      .toEqual({ show: false });
  });

  it('reports a restart when the process commit changes', () => {
    expect(decision({ ...reading(a), processHeadSha: a }, { ...reading(b), processHeadSha: b }))
      .toEqual({ show: true, reason: 'server-restarted', sha: b, message: 'Phantom restarted on new code — reload' });
    expect(decision({ ...reading(null), processHeadSha: a }, { ...reading(null), processHeadSha: b }))
      .toEqual({ show: true, reason: 'server-restarted', sha: null, message: 'Phantom restarted on new code — reload' });
  });

  it('preserves the disk comparison when either process commit is missing or invalid', () => {
    const first = { ...reading(a), processHeadSha: a };
    const current = { ...reading(b), processHeadSha: b };
    const invalid = { ...reading(b), processHeadSha: 42 };
    for (const [before, after] of [[reading(a), reading(b)], [first, reading(b)], [reading(a), current], [first, invalid]] as const) {
      expect(decision(before, after)).toMatchObject({ show: true, reason: 'server-restarted' });
    }
  });
});
