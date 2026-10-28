import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { claimFleetWork, readFleetBoard } from '../../src/core/fleet/coordination.js';
import { buildCodingFleetSnapshot, writeCodingFleetSnapshot } from '../../src/core/fleet/coding-snapshot.js';

/** Registered by remote-gateway-http.test.ts, which runs in the serialized real-I/O lane. */
export function registerFleetIntegrationTests(): void {
  describe('fleet real-I/O boundaries', () => {
    const dirs: string[] = [];
    const temporaryDirectory = (prefix: string): string => {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    };
    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    // The executable fixture uses /bin/sh; dispatch unit tests remain cross-platform.
    it.runIf(process.platform !== 'win32')('runs the source fleet command end to end and publishes exactly its JSON snapshot', () => {
      const dir = temporaryDirectory('phantom-fleet-cli-');
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      // Deterministic successful read-only GitHub fixture, never a live API call.
      writeFileSync(join(bin, 'gh'), '#!/bin/sh\n[ "$1" = "pr" ] && [ "$2" = "list" ] || exit 5\nprintf "[]"\n', { mode: 0o700 });
      const path = join(dir, 'fleet.json');
      const env = { ...process.env, HOME: dir, USERPROFILE: dir, PATH: `${bin}:${process.env.PATH}`, ASHLR_HOME: dir,
        PHANTOM_FLEET_PATH: path, PRIVATE_FLEET_TEST_TOKEN: 'unshaped-private-canary-4751', NO_COLOR: '1' };
      const run = (args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'fleet', ...args],
        { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });
      const output = run(['status', '--coding', '--json']);
      const snapshot = JSON.parse(output);
      expect(snapshot).toEqual(JSON.parse(readFileSync(path, 'utf8')));
      expect(snapshot.schema).toBe('fleet.v1');
      expect(snapshot.pools).toHaveLength(8);
      expect(snapshot.pools.find((p: { id: string }) => p.id === 'codex-cmp')).toMatchObject({ used_pct: null, projected_pct: null, source: 'unknown' });
      expect(snapshot.repos.every((r: { open: unknown[]; merged: unknown[] }) => r.open.length === 0 && r.merged.length === 0)).toBe(true);
      expect(output).not.toContain(env.PRIVATE_FLEET_TEST_TOKEN);
      expect(run(['status', '--coding'])).toContain('unknown');
      expect(run(['claim', '--help'])).toContain('--lease');
      expect(existsSync(join(dir, 'fleet', 'coordination.jsonl'))).toBe(false);
    });

    it.each([false, true])('serializes actual concurrent host processes so exactly one wins a duplicate race (compaction=%s)', async compact => {
      const dir = temporaryDirectory('phantom-fleet-coordination-');
      const options = { path: join(dir, 'coordination.jsonl'), now: 1000 };
      if (compact) {
        const tombstone = JSON.stringify({ version: 1, kind: 'release', at: 1000, id: 'old-claim' }) + '\n';
        writeFileSync(options.path, tombstone.repeat(20_000), { mode: 0o600 });
      }
      const work = { repo: 'ashlrai/phantom', task: 'Verify fleet snapshot', agent: 'codex-cmp', ttlMs: 1000 };
      const moduleUrl = pathToFileURL(resolve('src/core/fleet/coordination.ts')).href;
      const script = `import { claimFleetWork } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(claimFleetWork(${JSON.stringify(work)}, ${JSON.stringify(options)})));`;
      const run = () => new Promise<{ ok: boolean; error?: string }>((accept, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
          cwd: process.cwd(), env: { ...process.env, HOME: dir, USERPROFILE: dir }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
        });
        let out = ''; let err = '';
        child.stdout.on('data', data => { out += String(data); });
        child.stderr.on('data', data => { err += String(data); });
        child.on('error', reject);
        child.on('close', code => {
          if (code !== 0) reject(new Error(err));
          else { try { accept(JSON.parse(out)); } catch (error) { reject(error); } }
        });
      });
      const results = await Promise.all([run(), run(), run()]);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.filter(result => result.error === 'duplicate')).toHaveLength(2);
      expect(readFleetBoard(options).claims).toHaveLength(1);
      expect(claimFleetWork(work, options)).toEqual({ ok: false, error: 'duplicate' });
    });

    it('rejects a non-regular file substituted between lstat and open without blocking', async () => {
      const dir = temporaryDirectory('fleet-snapshot-');
      const path = join(dir, 'fleet.json');
      const home = join(dir, 'home');
      const nowMs = Date.parse('2026-10-26T12:00:00Z');
      mkdirSync(home, { mode: 0o700 });
      const snapshot = await buildCodingFleetSnapshot({ path, home, nowMs, fetchGithub: false });
      writeCodingFleetSnapshot(snapshot, path);
      const moduleUrl = pathToFileURL(resolve('src/core/fleet/coding-snapshot.ts')).href;
      // POSIX substitutes a FIFO; Windows substitutes a directory (no native mkfifo).
      // Isolate the native fs hook in a child: the HTTP gateway keeps its real fs
      // exports, and a regression that blocks opening the FIFO has a hard deadline.
      const script = `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { execFileSync } from 'node:child_process';
        const target = ${JSON.stringify(path)};
        const open = fs.openSync;
        let substituted = false;
        fs.openSync = (...args) => {
          if (args[0] === target && !substituted) {
            substituted = true;
            fs.rmSync(target);
            if (process.platform === 'win32') fs.mkdirSync(target);
            else execFileSync('/usr/bin/mkfifo', [target]);
          }
          return open(...args);
        };
        syncBuiltinESMExports();
        const { readCodingFleetSnapshot } = await import(${JSON.stringify(moduleUrl)});
        const result = readCodingFleetSnapshot(target, { nowMs: ${nowMs} });
        process.stdout.write(JSON.stringify({ result, substituted }));
      `;
      const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: process.cwd(), env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 10_000,
      });
      const result = JSON.parse(output) as { result: unknown; substituted: boolean };
      expect(result.result).toBeNull();
      expect(result.substituted).toBe(true);
    });
  });
}
