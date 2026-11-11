import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetAgentProfiles } from '../src/cli/fleet-agent-profiles.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { writeAgentProfile } from '../src/core/agents/agent-profile.js';

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-profile-cli-'));
  previousHome = process.env.HOME;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      home,
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
    },
  };
}

async function run(args: string[]) {
  const { out, err, deps } = capture();
  const code = await cmdFleetAgentProfiles(args, deps);
  return { code, out, err };
}

async function seedTwoVersions() {
  const first = await writeAgentProfile(
    { id: 'helper', displayName: 'Helper', doctrine: 'doctrine.md' }, home);
  const second = await writeAgentProfile({ ...first, displayName: 'Helper v2' }, home);
  expect(second.version).toBe(2);
  return { first, second };
}

async function profileBytes(): Promise<Record<string, string>> {
  const dir = join(home, '.phantom', 'agents');
  const bytes: Record<string, string> = {};
  for (const name of ['helper.toml']) {
    bytes[name] = await readFile(join(dir, name), 'utf8');
  }
  bytes['helper.versions/1.toml'] = await readFile(join(dir, 'helper.versions', '1.toml'), 'utf8');
  return bytes;
}

describe('ashlr fleet agent-profiles', () => {
  it('loads through the generated fleet registry and dispatches via cmdFleet', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['agent-profiles']!()).cmdFleetAgentProfiles).toBe(cmdFleetAgentProfiles);
    await seedTwoVersions();
    process.env.HOME = home;
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await cmdFleet(['agent-profiles', 'versions', 'helper', '--json'], FLEET_SUBCOMMAND_LOADERS);
    expect(code).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual({ id: 'helper', versions: [1, 2] });
  });

  it('lists profiles and reports the archived revision inventory without mutating files', async () => {
    const { second } = await seedTwoVersions();
    const before = await profileBytes();

    const list = await run(['list', '--json']);
    expect(list.code).toBe(0);
    const listed = JSON.parse(list.out[0]!);
    expect(listed.profiles).toHaveLength(1);
    expect(listed.profiles[0]).toMatchObject({ id: 'helper', version: second.version, displayName: 'Helper v2' });

    const versions = await run(['versions', 'helper']);
    expect(versions.code).toBe(0);
    expect(JSON.parse(versions.out[0]!)).toEqual({ id: 'helper', versions: [1, 2] });

    const show = await run(['show', 'helper', '--json']);
    expect(show.code).toBe(0);
    expect(JSON.parse(show.out[0]!).profile).toMatchObject({ id: 'helper', version: 2 });

    const validate = await run(['validate', 'helper', '--json']);
    expect(validate.code).toBe(0);
    expect(JSON.parse(validate.out[0]!)).toEqual({ id: 'helper', valid: true, version: 2 });

    expect(await profileBytes()).toEqual(before);
  });

  it('rejects unknown verbs, extra operands, unknown and duplicate flags before reading profiles', async () => {
    await seedTwoVersions();
    const before = await profileBytes();
    for (const args of [
      ['frobnicate'],
      ['list', 'extra'],
      ['show'],
      ['show', 'helper', 'extra'],
      ['versions', 'helper', '--bogus'],
      ['list', '--json', '--json'],
      [],
    ]) {
      const { code, err } = await run(args);
      expect(code, JSON.stringify(args)).toBe(2);
      expect(err.join('\n')).not.toContain(home);
    }
    expect(await profileBytes()).toEqual(before);
  });

  it('fails cleanly on missing, malformed and invalid-id profiles without echoing contents or paths', async () => {
    await seedTwoVersions();
    const dir = join(home, '.phantom', 'agents');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'broken.toml'), 'this is = = not toml', 'utf8');

    for (const args of [['show', 'ghost'], ['versions', 'ghost'], ['show', 'broken'], ['validate', 'broken'], ['show', '../escape']]) {
      const { code, out, err } = await run([...args, '--json']);
      expect(code, JSON.stringify(args)).toBe(2);
      expect(out).toHaveLength(0);
      const payload = JSON.parse(err[0]!);
      expect(payload.ok).toBe(false);
      expect(err.join('\n')).not.toContain(home);
      expect(err.join('\n')).not.toContain('not toml');
    }
  });

  it('prints help and exits 0 without touching an inaccessible home', async () => {
    const missing = join(home, 'does-not-exist');
    for (const flag of ['--help', '-h', 'help']) {
      const out: string[] = [];
      const code = await cmdFleetAgentProfiles([flag], { home: missing, out: (t) => out.push(t) });
      expect(code).toBe(0);
      expect(out[0]).toMatch(/^Usage: ashlr fleet agent-profiles/);
    }
  });
});
