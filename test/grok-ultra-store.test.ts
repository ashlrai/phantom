import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetGrokUsage } from '../src/cli/fleet-grok-usage.js';
import { cmdFleet } from '../src/cli/fleet.js';
import { grokUltraFleetPath, readGrokUltraRunway, recordManualGrokUltraReading } from '../src/core/fleet/grok-ultra-store.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const reading = (hoursAgo = 0, remainingPoints = 800) => ({ timestamp: new Date(NOW - hoursAgo * 3_600_000).toISOString(), remainingPoints, totalPoints: 1000 });
let root: string;
let file: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'grok-usage-test-')));
  file = join(root, 'fleet.json');
  vi.stubEnv('PHANTOM_FLEET_FILE', file);
  vi.stubEnv('PHANTOM_POSTHOG_PROJECT_KEY', '');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('Grok usage fleet store', () => {
  it('reads missing history without writing or sampling the app', async () => {
    const request = vi.spyOn(globalThis, 'fetch');
    expect(grokUltraFleetPath()).toBe(file);
    expect((await readGrokUltraRunway(file, NOW)).state).toBe('manual-required');
    expect(existsSync(file)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves unrelated fleet fields and persists manual provenance with private modes', async () => {
    const existing = { schema: 'fleet.v1', pools: [{ id: 'other', left: 10 }], claims: ['private-claim'], messages: ['private-message'] };
    writeFileSync(file, JSON.stringify(existing), { mode: 0o600 });
    recordManualGrokUltraReading(reading(24, 950), file, NOW);
    recordManualGrokUltraReading(reading(6, 860), file, NOW);
    const result = recordManualGrokUltraReading(reading(), file, NOW);
    const document = JSON.parse(readFileSync(file, 'utf8'));
    expect(document).toMatchObject(existing);
    expect(document.grokUltra.readings).toHaveLength(3);
    expect(document.grokUltra.readings[2]).toEqual({ source: 'manual', ...reading() });
    expect(result.burnPointsPerHour).toEqual({ h1: 10, h6: 10, h24: 6.25 });
    expect(await readGrokUltraRunway(file, NOW)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/private-claim|private-message|pools|\/fleet\.json/);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('creates nested storage but leaves existing directory permissions intact', () => {
    if (process.platform !== 'win32') chmodSync(root, 0o755);
    recordManualGrokUltraReading(reading(), file, NOW);
    if (process.platform !== 'win32') expect(statSync(root).mode & 0o777).toBe(0o755);
    const nested = join(root, 'nested', 'fleet.json');
    recordManualGrokUltraReading(reading(), nested, NOW);
    expect(existsSync(nested)).toBe(true);
  });

  it('does not extend freshness or add samples on identical retries', () => {
    recordManualGrokUltraReading(reading(), file, NOW);
    const before = readFileSync(file, 'utf8');
    const result = recordManualGrokUltraReading(reading(), file, NOW + 3_600_000);
    expect(result.state).toBe('stale');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(() => recordManualGrokUltraReading(reading(1), file, NOW)).toThrow();
    expect(() => recordManualGrokUltraReading(reading(0, 700), file, NOW)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it.each(['{broken', '[]', '{"grokUltra":{"v":2,"readings":[]}}', '{"grokUltra":{"v":1,"readings":[{}]}}'])(
    'refuses invalid existing history without overwriting it: %s', async (text) => {
      writeFileSync(file, text, { mode: 0o600 });
      expect((await readGrokUltraRunway(file, NOW)).state).toBe('unavailable');
      expect(() => recordManualGrokUltraReading(reading(), file, NOW)).toThrow();
      expect(readFileSync(file, 'utf8')).toBe(text);
    });

  it('refuses future/unordered histories and future manual input', async () => {
    const future = reading(-1);
    expect(() => recordManualGrokUltraReading(future, file, NOW)).toThrow();
    writeFileSync(file, JSON.stringify({ grokUltra: { v: 1, readings: [{ source: 'manual', ...future }] } }), { mode: 0o600 });
    const before = readFileSync(file, 'utf8');
    expect((await readGrokUltraRunway(file, NOW)).state).toBe('unavailable');
    expect(() => recordManualGrokUltraReading(reading(), file, NOW)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses unsafe file aliases without modifying the target', async () => {
    const target = join(root, 'target.json');
    writeFileSync(target, '{}', { mode: 0o600 });
    symlinkSync(target, file);
    expect((await readGrokUltraRunway(file, NOW)).state).toBe('unavailable');
    expect(() => recordManualGrokUltraReading(reading(), file, NOW)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('{}');
    rmSync(file);
    linkSync(target, file);
    expect((await readGrokUltraRunway(file, NOW)).state).toBe('unavailable');
    expect(() => recordManualGrokUltraReading(reading(), file, NOW)).toThrow();
  });

  it('refuses symlinked directories and arbitrary non-fleet paths', async () => {
    const directory = join(root, 'real'); mkdirSync(directory);
    const alias = join(root, 'alias'); symlinkSync(directory, alias, 'dir');
    const path = join(alias, 'fleet.json');
    expect((await readGrokUltraRunway(path, NOW)).state).toBe('unavailable');
    expect(() => recordManualGrokUltraReading(reading(), path, NOW)).toThrow();
    expect(() => recordManualGrokUltraReading(reading(), join(alias, 'nested', 'fleet.json'), NOW)).toThrow();
    expect(existsSync(join(directory, 'nested'))).toBe(false);
    expect(() => recordManualGrokUltraReading(reading(), join(root, 'Cookies'), NOW)).toThrow();
    expect((await readGrokUltraRunway('fleet.json', NOW)).state).toBe('unavailable');
  });

  it('rejects non-regular fleet paths without opening them', async () => {
    mkdirSync(file);
    expect((await readGrokUltraRunway(file, NOW)).state).toBe('unavailable');
    expect(() => recordManualGrokUltraReading(reading(), file, NOW)).toThrow();
  });

  it('does not overwrite a cooperating writer holding the lock', () => {
    const lock = acquireLocalStoreLock(join(root, '.fleet-locks', 'fleet.json.lock'), 250, { anchorPath: root });
    expect(lock).not.toBeNull();
    try {
      expect(() => recordManualGrokUltraReading(reading(), file, NOW)).toThrow();
      expect(existsSync(file)).toBe(false);
    } finally { releaseLocalStoreLock(lock); }
    recordManualGrokUltraReading(reading(), file, NOW);
    expect(existsSync(file)).toBe(true);
  });

  it('bounds file size without overwriting oversized history', async () => {
    const huge = ' '.repeat(2 * 1024 * 1024 + 1);
    writeFileSync(file, huge, { mode: 0o600 });
    expect((await readGrokUltraRunway(file, NOW)).state).toBe('unavailable');
    expect(() => recordManualGrokUltraReading(reading(), file, NOW)).toThrow();
    expect(statSync(file).size).toBe(huge.length);
  });

  it('does not accept injected app-local provenance through the manual writer', () => {
    recordManualGrokUltraReading({ ...reading(), source: 'app-local' } as ReturnType<typeof reading>, file, NOW);
    expect(JSON.parse(readFileSync(file, 'utf8')).grokUltra.readings[0].source).toBe('manual');
  });
});

describe('manual usage CLI', () => {
  it('records, reads and reports disabled analytics through the real store', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdFleetGrokUsage(['record', '--remaining-points', '800', '--total-points', '1000', '--json'])).toBe(0);
    const recorded = JSON.parse(String(output.mock.calls.at(-1)![0]));
    expect(recorded.latest.source).toBe('manual');
    expect(recorded.telemetry).toBe('disabled');
    const before = readFileSync(file, 'utf8');
    expect(await cmdFleetGrokUsage(['status', '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).latest.remainingPoints).toBe(800);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it.each([
    ['record', '--remaining-points', '800'], ['record', '--source', 'app-local'],
    ['status', '--at', 'now'], ['record', '--remaining-points', '1', '--total-points', '2', '--json', '--json'],
    ['record', '--remaining-points', '1', '--remaining-points', '1', '--total-points', '2'],
    ['status', '--file'], ['record', '--remaining-points', '0x10', '--total-points', '1000'],
    ['record', '--remaining-points', '-1', '--total-points', '1000'],
  ])('refuses invalid arguments before persistence: %j', async (args) => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await cmdFleetGrokUsage(args)).not.toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('help does not create storage or emit telemetry', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const request = vi.spyOn(globalThis, 'fetch');
    expect(await cmdFleet(['grok-usage', 'record', '--help'])).toBe(0);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('--remaining-points'));
    expect(existsSync(file)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
