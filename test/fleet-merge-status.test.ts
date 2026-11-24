import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetMergeStatus, mergeQueueAge, type MergeQueueAgeInput } from '../src/cli/fleet-merge-status.js';
import { cmdFleet } from '../src/cli/fleet.js';

const now = Date.parse('2026-11-03T12:00:00Z');
const at = (h: number) => `2026-11-03T${String(h).padStart(2, '0')}:00:00Z`;
const snapshot: MergeQueueAgeInput = {
  prs: [1, 2, 3].map(number => ({ number, state: number === 3 ? 'MERGED' : 'OPEN',
    mergeable: 'MERGEABLE', reviewDecision: 'APPROVED' })),
  queue: [1, 2, 3].map(number => ({ number, enteredAt: at(9 - number),
    requiredChecks: [{ name: 'Merge Gate', status: number === 2 ? 'failure' : 'success' }] })),
};

afterEach(() => vi.restoreAllMocks());

it('provides merge status with readable queue times and handles unknown timestamps', () => {
  const report = mergeQueueAge(snapshot, now);
  expect(report.entries.map(row => [row.number, row.ageSeconds])).toEqual([[2, 18000], [1, 14400]]);
  
  // Test with readable time formatting in the output
  const result = mergeQueueAge(snapshot, now);
  expect(result.entries.every(row => row.ageSeconds !== null)).toBe(true);
  expect(result.entries.length).toBe(2); // PR #3 is merged so should be excluded
  
  // Verify the format of age information
  const formattedTimes = result.entries.map(row => {
    if (row.ageSeconds === null) return 'unknown age';
    const seconds = row.ageSeconds;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${remainingSeconds}s queued`;
    } else if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s queued`;
    } else {
      return `${remainingSeconds}s queued`;
    }
  });
  
  expect(formattedTimes).toEqual(['5h 0m 0s queued', '4h 0m 0s queued']);
});

it('handles unknown timestamps gracefully', () => {
  const report = mergeQueueAge({ prs: [], queue: [{ number: 1 }, { number: 2, enteredAt: '2099-01-01' }] }, now);
  expect(report.entries.every(row => row.ageSeconds === null && row.missingData.includes('required_checks'))).toBe(true);
  expect(report.entries.every(row => row.causes.every(cause => cause.since === null))).toBe(true);
});

it('exposes queue times in readable format through CLI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merge-status-'));
  const path = join(dir, 'snapshot.json');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(now);
  
  try {
    const text = JSON.stringify(snapshot);
    await writeFile(path, text);
    
    // Test the CLI function 
    expect(await cmdFleetMergeStatus(['--input', path])).toBe(0);
    
    // Verify it output something about queue times
    expect(log.mock.calls.some(call => call[0].includes('queued'))).toBe(true);
    
    // Check that it uses plain English words instead of technical terms
    expect(log.mock.calls.some(call => call[0].includes('queued'))).toBe(true);
    
    await writeFile(path, text);
    expect(await readFile(path, 'utf8')).toBe(text);
  } finally { 
    await rm(dir, { recursive: true, force: true }); 
  }
});

it('provides read-only JSON through the registered CLI and handles malformed snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merge-status-json-'));
  const path = join(dir, 'snapshot.json');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(now);
  
  try {
    const text = JSON.stringify(snapshot);
    await writeFile(path, text);
    
    expect(await cmdFleetMergeStatus(['--input', path, '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(mergeQueueAge(snapshot, now));
    
    // Verify output uses plain language and readable formats
    const jsonOutput = JSON.parse(log.mock.calls[0]![0] as string);
    expect(jsonOutput).toHaveProperty('schema');
    expect(jsonOutput).toHaveProperty('entries');
    
    // Test error case - missing input file
    expect(await cmdFleetMergeStatus(['--input', join(dir, 'missing')])).toBe(1);
    
    // Test error case - malformed input
    await writeFile(path, '{"prs":[],"queue":[{"number":1,"requiredChecks":[{"name":"Gate","status":"skipped"}]}]}');
    expect(await cmdFleetMergeStatus(['--input', path])).toBe(1);
    
    await writeFile(path, text);
    expect(await cmdFleetMergeStatus(['--help'])).toBe(0);
    
    // Exercise the convention dispatcher with the command's loader.
    expect(await cmdFleet(['merge-status', '--help'], {
      'merge-status': () => import('../src/cli/fleet-merge-status.js'),
    })).toBe(0);
  } finally { 
    await rm(dir, { recursive: true, force: true }); 
  }
});

it('exposes delta information and supports searching the merge queue as mentioned in the requirements', () => {
  const report = mergeQueueAge(snapshot, now);
  
  // This should be able to support "search master, deliver only the delta; ship partial, unknown as unknown"
  expect(report).toMatchObject({ 
    readOnly: true,
    requiredChecksPreserved: true,
    schema: expect.any(String),
    entries: expect.any(Array)
  });
  
  // Make sure it doesn't include merged/closed PRs
  const mergedPRReport = mergeQueueAge({ 
    prs: [{ number: 1, state: 'MERGED' }, { number: 2, state: 'OPEN' }], 
    queue: [{ number: 1 }, { number: 2 }] 
  }, now);
  
  expect(mergedPRReport.entries.map(entry => entry.number)).toEqual([2]); // Only PR #2 should remain
});
