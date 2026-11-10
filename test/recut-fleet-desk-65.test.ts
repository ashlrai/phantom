// Recut of #4469 (RQ-PHX-DISKFORECASTCARD43): the Fleet host pane explains disk
// runway from the read-only forecast route, and never invents a number.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createFleetMemoryApi, VERSE_FLEET_DISK_FORECAST_PATH } from '../src/core/verse/fleet-memory-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { diskForecastCard } from '../src/web-ui/routes/verse/fleet-host/disk-forecast-model.js';
import { narrowDiskForecast } from '../src/web-ui/routes/verse/fleet-host/disk-forecast-query.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

async function cardFor(history: string | null): Promise<ReturnType<typeof diskForecastCard>> {
  const runsDir = await mkdtemp(join(tmpdir(), 'recut-fleet-desk-65-'));
  roots.push(runsDir);
  if (history !== null) {
    await mkdir(join(runsDir, 'queue'));
    await writeFile(join(runsDir, 'queue', 'disk-growth-history.json'), history);
  }
  let status = 0, body = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(text: string) { body = text; } } as unknown as ServerResponse;
  const api = createFleetMemoryApi({ runsDir, now: () => 10 * 3_600_000 });
  expect(await api({ cfg: {} } as VerseApiContext, new PassThrough() as unknown as IncomingMessage, res, VERSE_FLEET_DISK_FORECAST_PATH, 'GET')).toBe(true);
  expect(status).toBe(200);
  const forecast = narrowDiskForecast(JSON.parse(body));
  expect(forecast).not.toBeNull();
  return diskForecastCard(forecast!);
}

describe('recut #4469: disk forecast card in the Fleet host pane', () => {
  it('turns falling disk history into a warning with hours and rate', async () => {
    // 210 GB -> 200 GB over one hour: 10 GB/h, 50 GB above the 150 GB line.
    const card = await cardFor(JSON.stringify([{ at: 0, free_gb: 210 }, { at: 3600, free_gb: 200 }]));
    expect(card.line).toMatch(/^Free disk reaches 150 GB in about 5 h \(.+\) at 10\.0 GB\/h$/);
    expect(card.tone).toBe('bad');
    expect(card.caption).toMatch(/^2 samples · /);
  });

  it('says unknown, not a guessed number, when no history exists', async () => {
    const card = await cardFor(null);
    expect(card).toEqual({ line: 'Disk trend unknown: not enough samples', tone: 'ok', caption: '0 samples · window unknown' });
    expect(card.line).not.toMatch(/\d+ h/);
  });

  it('reports a reached threshold from one sample under the line', async () => {
    const card = await cardFor(JSON.stringify([{ at: 60, free_gb: 140 }]));
    expect(card).toMatchObject({ line: 'Free disk is at or under 150 GB now', tone: 'bad' });
  });
});
