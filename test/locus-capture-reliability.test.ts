/** Fake CLI + local fake schema repository only; never invokes Locus or a provider. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root: string;
let source: string;
let sha: string;
let cli: string;
let calls: string;
let settings: string;
const capture = resolve('scripts/capture-locus-contract-fixtures.mjs');
function git(args: string[]) {
  const r = spawnSync('/usr/bin/git', args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'locus-fake-capture-')));
  source = join(root, 'fake-source'); mkdirSync(join(source, 'schema'), { recursive: true });
  for (const name of ['agent-report.schema.json', 'doctor.schema.json']) writeFileSync(join(source, 'schema', name), '{"type":"object"}\n');
  git(['init', '--quiet', source]); git(['-C', source, 'add', 'schema']);
  git(['-C', source, '-c', 'user.name=Offline fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fake schemas']);
  sha = git(['-C', source, 'rev-parse', 'HEAD']);
  calls = join(root, 'calls.jsonl'); settings = join(root, 'settings.json'); cli = join(root, 'fake locus');
  writeFileSync(settings, JSON.stringify({ countdown: 43199 }));
  const program = `${cli}.cjs`;
  writeFileSync(program, `const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const settings = JSON.parse(fs.readFileSync(${JSON.stringify(settings)}, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args,home:process.env.HOME,locusHome:process.env.LOCUS_HOME,cwd:process.cwd(),env:process.env})+'\\n');
fs.writeFileSync(path.join(process.env.HOME, 'fake-probe-touch'), 'fake only');
if (args[0] === settings.fail) { console.log('locus 0.5.0'); process.exit(7); }
if (args[0] === '--version' && settings.hang) {
  const heartbeat = ${JSON.stringify(join(root, 'heartbeat'))};
  const child = cp.spawn(process.execPath, ['-e', 'const fs=require("node:fs");process.on("SIGTERM",()=>{});setInterval(()=>fs.writeFileSync('+JSON.stringify(heartbeat)+',String(Date.now())),20)'], {stdio:'ignore'});
  fs.writeFileSync(${JSON.stringify(join(root, 'descendant.pid'))}, String(child.pid));
  setInterval(()=>{},1000);
} else if (args[0] === '--version') console.log(settings.versionOutput ?? (settings.invalidVersion ? 'not a version' : 'locus 0.5.0'));
else if (args[0] === '--help') console.log('Usage: locus [command]');
else if (args[0] === 'quickstart') fs.writeFileSync(path.join(process.env.LOCUS_HOME,'control_capability'),'fake-control-sentinel');
else if (args[0] === 'status') console.log('unpinned');
else {
  const n = settings.fraction ? 0.5 : settings.countdown;
  const report = {ready:false,session_ok:false,expired:true,status:'protected',home:process.env.HOME,expires_in_secs:n,
    nested:[{expires_in_secs:0},{expires_in_secs:-8},{expires_in_secs:null},{session_id:'random-'+n,seal:settings.leak?'fake-control-sentinel':'random-seal-'+n}],
    ts:'random-time-'+n};
  console.log(args[0] === 'watch' ? JSON.stringify(report) : JSON.stringify(report,null,2));
}
`);
  const nodeAlias = join(root, 'Node runtime with spaces');
  symlinkSync(process.execPath, nodeAlias);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(cli, `#!/bin/sh\nexec ${quote(nodeAlias)} ${quote(program)} "$@"\n`, { mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function configure(value: object) { writeFileSync(settings, JSON.stringify({ countdown: 43199, ...value })); }
function run(name = 'out', commit = sha) {
  const ambient = join(root, 'ambient-home'); mkdirSync(ambient, { recursive: true });
  const r = spawnSync(process.execPath, [capture, '--locus-bin', cli, '--locus-src', source, '--source-commit', commit,
    '--out', join(root, name), '--timeout-seconds', '1'], { encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH, HOME: ambient, LOCUS_HOME: ambient, TMPDIR: root,
      GH_TOKEN: 'fake-ambient-secret', LOCUS_CONTROL_CAPABILITY: 'fake-ambient-cap', LOCUS_INTERNAL_AUTHORITY_ANCHOR_SERVER: '1', NODE_OPTIONS: '--no-warnings' } });
  if (r.error) throw r.error;
  return r;
}
function observed() {
  return readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as {
    args: string[]; home: string; locusHome: string; cwd: string; env: Record<string, string>;
  });
}
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { recursive: true }).map(String).filter(name => statSync(join(dir, name)).isFile()).map(name => [name, readFileSync(join(dir, name), 'utf8')]));
}

describe.skipIf(process.platform === 'win32')('capture reliability with a fake producer', () => {
  it('isolates every metadata/scenario invocation and preserves sign classes, null and held state', () => {
    const r = run(); expect(r.status, r.stderr).toBe(0);
    const seen = observed(); expect(seen).toHaveLength(16);
    expect(seen.slice(0,2).map(call => call.args[0])).toEqual(['--version','--help']);
    for (const call of seen) {
      expect(call.home).toBe(call.locusHome); expect(call.home).not.toBe(join(root,'ambient-home'));
      expect(call.cwd).not.toBe(process.cwd());
      expect(call.env.PATH).toBe('/usr/bin:/bin');
      for (const key of ['GH_TOKEN','NODE_OPTIONS','LOCUS_INTERNAL_AUTHORITY_ANCHOR_SERVER']) expect(call.env[key]).toBeUndefined();
      expect(call.env.LOCUS_CONTROL_CAPABILITY ?? null).toBe(call.home.includes('pinned-capability-exported') && call.args[0] !== 'quickstart' ? 'fake-control-sentinel' : null);
      expect(existsSync(dirname(dirname(call.home)))).toBe(false);
    }
    expect(existsSync(join(root,'ambient-home','fake-probe-touch'))).toBe(false);
    for (const scenario of ['fresh-home','pinned-capability-not-exported','pinned-capability-exported']) {
      for (const file of ['agent-report.json','verify-session.json','watch-once.json']) {
        const text = readFileSync(join(root,'out',scenario,file),'utf8');
        const report = JSON.parse(text);
        expect(report).toMatchObject({ready:false,session_ok:false,expired:true,status:'protected',home:'<LOCUS_HOME>',expires_in_secs:1});
        expect(report.nested.slice(0,3)).toEqual([{expires_in_secs:0},{expires_in_secs:-1},{expires_in_secs:null}]);
        expect(report.nested[3]).toEqual({session_id:'<SESSION_ID>',seal:'<SEAL>'});
        if (file === 'watch-once.json') expect(text.trim().split('\n')).toHaveLength(1);
      }
    }
    const manifest = JSON.parse(readFileSync(join(root,'out','manifest.json'),'utf8'));
    expect(manifest.sourceCommit).toBe(sha); expect(manifest.binarySourceProvenance).toBe('caller-supplied-not-attested');
    expect(manifest.normalizedKeys).toContain('expires_in_secs');
  }, 20_000);
  it('normalizes equivalent captures with different elapsed seconds to the same bytes', () => {
    expect(run('first').status).toBe(0); configure({countdown:43198}); expect(run('second').status).toBe(0);
    expect(snapshot(join(root,'first'))).toEqual(snapshot(join(root,'second')));
  }, 20_000);
  it.each(['--version','--help'])('rejects failed %s metadata and cleans its scratch home', fail => {
    configure({fail}); const r = run(); expect(r.status).not.toBe(0); expect(r.stderr).toContain('exit 7');
    expect(existsSync(join(root,'out','manifest.json'))).toBe(false);
    expect(existsSync(dirname(dirname(observed()[0]!.home)))).toBe(false);
  }, 20_000);
  it('rejects invalid version output and an unavailable schema source', () => {
    configure({invalidVersion:true}); expect(run('bad-version').stderr).toContain('unexpected locus --version');
    configure({}); const r = run('bad-source','f'.repeat(40)); expect(r.status).not.toBe(0);
    expect(existsSync(join(root,'bad-source','manifest.json'))).toBe(false);
    for (const call of observed()) expect(existsSync(dirname(dirname(call.home)))).toBe(false);
  }, 20_000);
  it.each(['locus ../escape', 'locus 0.5/escape', 'locus 0.5', 'locus 0.5.0-../../escape', 'locus 0.5.0+../escape'])('rejects malformed/path version output %s before creating output', versionOutput => {
    configure({versionOutput}); const r = run();
    expect(r.status).not.toBe(0); expect(r.stderr).toContain('unexpected locus --version');
    expect(existsSync(join(root,'out'))).toBe(false);
    expect(existsSync(dirname(dirname(observed()[0]!.home)))).toBe(false);
  }, 20_000);
  it('accepts a conventional prerelease/build release token', () => {
    configure({versionOutput:'locus 0.5.0-rc.1+build.42'});
    const r = run(); expect(r.status, r.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(root,'out','manifest.json'),'utf8'));
    expect(manifest.version).toBe('0.5.0-rc.1+build.42');
    expect(readFileSync(join(root,'out','version.txt'),'utf8')).toBe('locus 0.5.0-rc.1+build.42\n');
  }, 20_000);
  it('rejects fractional countdowns rather than masking malformed producer data', () => {
    configure({fraction:true}); const r = run(); expect(r.status).not.toBe(0); expect(r.stderr).toContain('safe integer');
    expect(existsSync(join(root,'out','manifest.json'))).toBe(false);
  }, 20_000);
  it('checks raw capability leaks before redacting volatile string fields', () => {
    configure({leak:true}); const r = run(); expect(r.status).not.toBe(0); expect(r.stderr).toContain('capability value leaked');
    expect(existsSync(join(root,'out','manifest.json'))).toBe(false);
  }, 20_000);
  it('bounds a hung metadata probe and terminates its TERM-resistant descendant', async () => {
    configure({hang:true}); const r = run(); expect(r.status).not.toBe(0); expect(r.stderr).toContain('deadline exceeded');
    expect(existsSync(dirname(dirname(observed()[0]!.home)))).toBe(false);
    const heartbeat = join(root,'heartbeat'); expect(existsSync(heartbeat)).toBe(true);
    const before = readFileSync(heartbeat,'utf8');
    await new Promise(done => setTimeout(done,150));
    expect(readFileSync(heartbeat,'utf8')).toBe(before);
    expect(existsSync(join(root,'out','manifest.json'))).toBe(false);
  }, 20_000);
});
