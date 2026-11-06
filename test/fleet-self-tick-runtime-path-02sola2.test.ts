/**
 * RQ-PHX-TICKRUNTIMEPATH02SOLA2 — `--ashlr-path` and `--node-path` let a standby
 * host install its self-tick timer against the intended Node runtime and the
 * installed Phantom script instead of this checkout's entrypoint. The paths are
 * rendered into argv only: nothing loads a timer, runs a shell or touches the
 * real HOME, and the supplied paths need not exist on the machine running the test.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfTickSchedule } from '../src/cli/fleet-self-tick-schedule.js';
import { SELF_TICK_LABEL } from '../src/core/fleet/self-tick-schedule.js';
import { sanitizePublicJson } from '../src/core/util/public-json.js';

// Fake standby-host paths: spaces, XML metacharacters, quotes, a backslash, and the
// systemd specials `%` and `$`. Neither exists locally.
const NODE = '/opt/node & "22" 50%/bin/node';
const SCRIPT = '/srv/my phantom/dist/cli 50%$x\\y.js';
const PLATFORMS: NodeJS.Platform[] = ['darwin', 'linux'];

/** Decode the launchd ProgramArguments strings from a rendered plist. */
function plistArgv(contents: string): string[] {
  const array = /<key>ProgramArguments<\/key><array>(.*?)<\/array>/.exec(contents)?.[1] ?? '';
  return [...array.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
}

describe('fleet self-tick-schedule runtime paths (RQ-PHX-TICKRUNTIMEPATH02SOLA2)', () => {
  let home: string;
  let out: string[];
  let err: string[];
  let spawnCalls: string[][];
  const run = (args: string[], platform: NodeJS.Platform) => cmdFleetSelfTickSchedule(args, {
    home,
    platform,
    spawn: (argv) => { spawnCalls.push([...argv]); return { status: 0 }; },
    output: (text) => out.push(text),
    error: (text) => err.push(text),
  });
  const plist = () => join(home, 'Library', 'LaunchAgents', `${SELF_TICK_LABEL}.plist`);
  const service = () => join(home, '.config', 'systemd', 'user', 'phm-self-tick.service');
  const preview = () => JSON.parse(out.at(-1)!) as { ashlrPath: string; nodePath: string };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'self-tick-runtime-path-'));
    out = []; err = []; spawnCalls = [];
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('--help describes both flags', async () => {
    expect(await run(['--help'], 'darwin')).toBe(0);
    expect(out[0]).toContain('--ashlr-path <abs>');
    expect(out[0]).toContain('--node-path <abs>');
  });

  it('preview reports the supplied paths without requiring them to exist', async () => {
    expect(await run(['--json', '--ashlr-path', SCRIPT, '--node-path', NODE], 'linux')).toBe(0);
    expect(preview()).toMatchObject({ ashlrPath: SCRIPT, nodePath: NODE });
    expect(readdirSync(home)).toEqual([]);
    expect(spawnCalls).toEqual([]);
  });

  it('macOS plist runs the supplied Node runtime and script as argv, XML-escaped', async () => {
    expect(await run(['--write', '--ashlr-path', SCRIPT, '--node-path', NODE], 'darwin')).toBe(0);
    expect(plistArgv(readFileSync(plist(), 'utf8'))).toEqual([NODE, SCRIPT, 'fleet', 'self-tick', '--json']);
    expect(readFileSync(plist(), 'utf8')).toContain('<string>/opt/node &amp; "22" 50%/bin/node</string>');
    expect(spawnCalls).toEqual([]);
  });

  it('Linux unit quotes both paths for systemd and never wraps them in a shell', async () => {
    expect(await run(['--write', '--ashlr-path', SCRIPT, '--node-path', NODE], 'linux')).toBe(0);
    const unit = readFileSync(service(), 'utf8');
    // Quotes and backslashes are escaped; `%` and argv `$` are doubled so systemd does not expand them.
    expect(unit).toContain(String.raw`ExecStart="/opt/node & \"22\" 50%%/bin/node" "/srv/my phantom/dist/cli 50%%$$x\\y.js" "fleet" "self-tick" "--json"`);
    expect(unit).not.toMatch(/ExecStart=.*\b(sh|bash)\b/);
    expect(spawnCalls).toEqual([]);
  });

  it('omitted flags keep the defaults: this Node and this running CLI script', async () => {
    expect(await run(['--json'], 'linux')).toBe(0);
    expect(preview()).toMatchObject(sanitizePublicJson({
      ashlrPath: resolve(process.argv[1] ?? process.execPath),
      nodePath: process.execPath,
    }));
    expect(await run(['--write'], 'darwin')).toBe(0);
    const argv = plistArgv(readFileSync(plist(), 'utf8'));
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toBe(resolve(process.argv[1] ?? process.execPath));
  });

  const rejected: [string, string[]][] = [
    ['--ashlr-path with no value', ['--ashlr-path']],
    ['--node-path with no value', ['--node-path']],
    ['--node-path followed by another flag', ['--node-path', '--json']],
    ['--ashlr-path relative', ['--ashlr-path', 'dist/cli.js']],
    ['--node-path bare command name', ['--node-path', 'node']],
    ['--node-path empty', ['--node-path', '']],
    ['--ashlr-path duplicated', ['--ashlr-path', '/srv/a.js', '--ashlr-path', '/srv/b.js']],
    ['--node-path duplicated', ['--node-path', '/opt/a', '--node-path', '/opt/a']],
    ['--ashlr-path with newline', ['--ashlr-path', '/srv/a\nb.js']],
    ['--node-path with NUL', ['--node-path', '/opt/a\u0000b']],
    ['--node-path with DEL', ['--node-path', '/opt/a\u007fb']],
  ];
  for (const platform of PLATFORMS) {
    describe(`on ${platform}`, () => {
      it.each(rejected)('%s exits 2 before any write or activation', async (_label, flags) => {
        expect(await run([...flags, '--write', '--load'], platform)).toBe(2);
        expect(err.join('\n')).toContain('Invalid arguments');
        expect(readdirSync(home)).toEqual([]);
        expect(spawnCalls).toEqual([]);
      });
    });
  }
});
