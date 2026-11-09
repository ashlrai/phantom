import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianContinue } from '../src/cli/fleet-guardian-continue.js';

const summary = JSON.stringify({ mode: 'apply', termination: 'drained', attempts: 1, verified: 1, refused: 0,
  attempted: [], planned: [], latestOutput: null, session: '/tmp/fake-guardian-session' });

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('guardian-continue input deadline', () => {
  it('times out a stalled injected reader and handles its late rejection', async () => {
    let rejectRead!: (error: Error) => void;
    const resume = vi.fn(async () => 0);
    const readInput = vi.fn((_signal: AbortSignal) => new Promise<string>((_resolve, reject) => { rejectRead = reject; }));
    const result = cmdFleetGuardianContinue(['--stdin', '--input-timeout-ms', '15'], { readInput, resume });
    await vi.advanceTimersByTimeAsync(15);
    expect(await result).toBe(2);
    expect(readInput.mock.calls[0]![0].aborted).toBe(true);
    expect(resume).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith('error: guardian-continue input timed out\n');
    rejectRead(new Error('late private error'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards other flags and clears the timer on success', async () => {
    const resume = vi.fn(async () => 5);
    const result = await cmdFleetGuardianContinue(['--stdin', '--manifest', '/tmp/fake', '--input-timeout-ms', '20', '--apply', '--timeout-ms', '42'],
      { readInput: async () => summary, resume });
    expect(result).toBe(5);
    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.calls[0]![0]).toEqual(['--checkpoint-dir', '/tmp/fake-guardian-session', '--manifest', '/tmp/fake', '--apply', '--timeout-ms', '42']);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it('rejects malformed deadlines before reading', async () => {
    const readInput = vi.fn(async () => summary);
    const resume = vi.fn(async () => 0);
    for (const args of [['--input-timeout-ms'], ['--input-timeout-ms', '--apply'], ['--input-timeout-ms', '0'],
      ['--input-timeout-ms', '300001'], ['--input-timeout-ms', '1.5'], ['--input-timeout-ms', 'Infinity'],
      ['--input-timeout-ms', '-1'], ['--input-timeout-ms', 'NaN'], ['--input-timeout-ms', '1', '--input-timeout-ms', '2']]) {
      expect(await cmdFleetGuardianContinue(['--stdin', ...args], { readInput, resume })).toBe(2);
    }
    expect(readInput).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('detaches the real stream reader on timeout without destroying the stream', async () => {
    const inputStream = new PassThrough();
    const resume = vi.fn(async () => 0);
    const result = cmdFleetGuardianContinue(['--stdin', '--input-timeout-ms', '10'], { inputStream, resume });
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBe(2);
    for (const event of ['readable', 'end', 'error']) expect(inputStream.listenerCount(event)).toBe(0);
    expect(inputStream.destroyed).toBe(false);
    expect(resume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a real stream before the deadline and cleans up listeners', async () => {
    const inputStream = new PassThrough();
    const resume = vi.fn(async () => 0);
    const result = cmdFleetGuardianContinue(['--stdin', '--input-timeout-ms', '10'], { inputStream, resume });
    await Promise.resolve();
    inputStream.end(summary);
    expect(await result).toBe(0);
    expect(resume).toHaveBeenCalledOnce();
    for (const event of ['readable', 'end', 'error']) expect(inputStream.listenerCount(event)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses oversized and malformed UTF-8 stream input', async () => {
    for (const data of [Buffer.alloc(32769, 120), Buffer.from([255])]) {
      const inputStream = new PassThrough();
      const resume = vi.fn(async () => 0);
      const result = cmdFleetGuardianContinue(['--stdin'], { inputStream, resume });
      await Promise.resolve();
      inputStream.end(data);
      expect(await result).toBe(2);
      expect(resume).not.toHaveBeenCalled();
      for (const event of ['readable', 'end', 'error']) expect(inputStream.listenerCount(event)).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
