import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readPortableFleetLanes } from '../core/fleet/portable-lanes.js';

const usage = 'Usage: phm fleet profile [--json] [--host <alias>]\nReport fleet setup drift from a Phantom checkout. Repeat --host for a matrix.';
const script = fileURLToPath(new URL('../../fleet/profile/apply.py', import.meta.url));

export async function cmdFleetProfile(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') continue;
    if (args[i] === '--host' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args[i + 1] ?? '')) { i++; continue; }
    console.error(usage);
    return 2;
  }
  if (!existsSync(script)) {
    console.error('fleet profile: use npm run dev -- fleet profile from a Phantom checkout');
    return 1;
  }
  const python = process.platform === 'win32' ? 'python' : 'python3';
  if (!args.includes('--host')) {
    return new Promise(resolve => {
      execFile(python, ['-I', script, ...args], { maxBuffer: 1024 * 1024 }, async (error, stdout, stderr) => {
        if (stderr) process.stderr.write(stderr);
        try {
          const report: unknown = JSON.parse(stdout);
          if (!report || typeof report !== 'object' || !('schema' in report) || report.schema !== 'fleet.profile.v1') throw new Error();
          console.log(JSON.stringify({ ...report, lanes: await readPortableFleetLanes() }, null, 2));
          resolve(typeof error?.code === 'number' ? error.code : error ? 1 : 0);
        } catch {
          console.error('fleet profile: local setup report unavailable');
          resolve(typeof error?.code === 'number' ? error.code : 1);
        }
      });
    });
  }
  return new Promise(resolve => {
    const child = spawn(python, ['-I', script, ...args], { stdio: 'inherit' });
    child.once('error', () => { console.error(`fleet profile: could not start ${python}`); resolve(1); });
    child.once('close', code => resolve(code ?? 1));
  });
}
