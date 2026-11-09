/**
 * `phm usage sensors` prints one freshness row per lane.
 * `--refresh` pulls official surfaces. `--file` reads or writes the snapshot
 * dispatchd can consume. Secret-shaped fields are dropped, never printed.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pullOfficialUsageSensors } from '../core/usage/sensor-pull.js';
import {
  USAGE_SENSOR_SCHEMA,
  parseUsageSensorSnapshot,
  presentUsageSensors,
  type UsageSensorReading,
  type UsageSensorReport,
} from '../core/usage/sensor-reading.js';

const USAGE = 'Usage: phm usage sensors --json [--refresh] [--file <snapshot>]';

function fail(): number {
  console.error(USAGE);
  return 2;
}

function age(ms: number | null): string {
  if (ms === null) return 'unknown';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function render(report: UsageSensorReport): void {
  console.log(USAGE_SENSOR_SCHEMA);
  for (const lane of report.lanes) {
    const room = lane.headroom === null ? 'unknown' : String(lane.headroom);
    console.log(`${lane.lane} ${lane.status} age=${age(lane.ageMs)} stale=${lane.stale} headroom=${room}`);
  }
}

async function readSnapshot(file: string): Promise<UsageSensorReading[]> {
  try {
    return parseUsageSensorSnapshot(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return [];
  }
}

export async function cmdUsageSensors(args: string[]): Promise<number> {
  let json = false;
  let refresh = false;
  let file: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--refresh') refresh = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return 0;
    } else if (arg === '--file') {
      const value = args[i + 1];
      if (!value || value.startsWith('-') || !isAbsolute(value)) return fail();
      file = value;
      i += 1;
    } else return fail();
  }

  let readings: UsageSensorReading[];
  if (refresh) {
    const home = (name: string): string | undefined => {
      const value = process.env[name];
      return typeof value === 'string' && isAbsolute(value) ? value : undefined;
    };
    try {
      readings = await pullOfficialUsageSensors({
        nowMs: Date.now(),
        codexCmpHome: home('PHANTOM_SENSOR_CODEX_CMP_HOME'),
        codexPersonalHome: home('PHANTOM_SENSOR_CODEX_PERSONAL_HOME'),
      });
    }
    catch { readings = []; }
    if (file) {
      try {
        await writeFile(file, `${JSON.stringify({ schema: USAGE_SENSOR_SCHEMA, readings }, null, 2)}\n`, { mode: 0o600 });
      } catch {
        console.error('Sensor snapshot was not written.');
        return 1;
      }
    }
  } else if (file) {
    readings = await readSnapshot(file);
  } else {
    readings = [];
  }

  const report = presentUsageSensors(readings, Date.now());
  if (json) console.log(JSON.stringify(report));
  else render(report);
  return 0;
}
