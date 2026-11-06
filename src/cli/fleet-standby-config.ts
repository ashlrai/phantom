/** Save the `fleet standby` connection flags once so any agent can run it with no arguments. */
import { chmodSync, closeSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  parseStandbyFlags, readStandbyConfig, STANDBY_REQUIRED, standbyRunsDir, validateStandbyValues,
} from './fleet-standby.js';

const usage = 'Usage: ashlr fleet standby-config [--db <lease.sqlite> --snapshot-store <dir> --primary <host> --role <name> --host <standby> [--max-age <60-86400>]] [--clear] [--json]';

export interface FleetStandbyConfigDeps {
  /** Directory for standby.json; default ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
  runsDir?: string;
}

export async function cmdFleetStandbyConfig(args: string[], deps: FleetStandbyConfigDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nSave the five flags of ashlr fleet standby to <runs dir>/standby.json (mode 0600) so ashlr fleet standby works with no arguments. With no flags, show the saved config; --clear removes it. Exit 2 on invalid arguments, nothing written.`);
    return 0;
  }
  const invalid = (): number => {
    console.error(`error: invalid fleet standby-config arguments\n${usage}`);
    return 2;
  };
  const parsed = parseStandbyFlags(args, ['--json', '--clear']);
  if (!parsed) return invalid();
  const { flags, values } = parsed;
  const file = join(standbyRunsDir(deps.runsDir), 'standby.json');
  const json = flags.has('--json');

  if (flags.has('--clear')) {
    if (values.size > 0) return invalid();
    rmSync(file, { force: true });
    console.log(json ? '{"cleared":true}' : 'Standby config cleared.');
    return 0;
  }
  if (values.size === 0) {
    const saved = readStandbyConfig(deps.runsDir);
    if (!saved) {
      console.log('No standby config. Set one with ashlr fleet standby-config --db … --snapshot-store … --primary … --role … --host …');
      return 0;
    }
    console.log(json ? JSON.stringify(configObject(saved)) : describe(saved));
    return 0;
  }
  if (STANDBY_REQUIRED.some((flag) => !values.has(flag))) return invalid();
  if (!validateStandbyValues(values)) return invalid();
  values.set('--db', resolve(values.get('--db')!));
  values.set('--snapshot-store', resolve(values.get('--snapshot-store')!));
  const config = configObject(values);
  const dir = standbyRunsDir(deps.runsDir);
  const tmp = join(dir, `.standby.json.${process.pid}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(tmp, 'w', 0o600);
    try { writeSync(fd, `${JSON.stringify(config)}\n`); } finally { closeSync(fd); }
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
    console.error('error: fleet standby-config could not write the config file');
    return 1;
  }
  console.log(json ? JSON.stringify(config) : `Saved. ${describe(values)}`);
  return 0;
}

function configObject(v: ReadonlyMap<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    v: 1, db: v.get('--db'), snapshotStore: v.get('--snapshot-store'),
    primary: v.get('--primary'), role: v.get('--role'), host: v.get('--host'),
  };
  if (v.has('--max-age')) out.maxAgeSec = Number(v.get('--max-age'));
  return out;
}

function describe(v: ReadonlyMap<string, string>): string {
  const age = v.has('--max-age') ? `, max age ${v.get('--max-age')} sec` : '';
  return `Standby config: role ${v.get('--role')}, primary ${v.get('--primary')}, standby ${v.get('--host')}, lease db ${v.get('--db')}, snapshots ${v.get('--snapshot-store')}${age}.`;
}
