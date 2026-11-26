import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { readSwarmPilotSpec } from '../src/core/swarm/pilot-plan.js';
import { evaluationExecutableDigest } from '../src/core/universe/artifacts.js';
import { validateUniverseManifest } from '../src/core/universe/store.js';

it('generates comparable Mac pilot and frontier inputs with working pinned oracles', context => {
  if (process.platform === 'win32') return context.skip();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-mac-recipe-')));
  try {
    const fixture = fileURLToPath(new URL('./fixtures/swarm-pilot-mac.mjs', import.meta.url));
    const poolDigest = 'a'.repeat(64);
    execFileSync(process.execPath, [fixture, root, 'fixture/private', 'frontier', 'ollama', 'fixture', poolDigest]);
    const load = (name: string): unknown => JSON.parse(readFileSync(join(root, name), 'utf8'));
    const pilot = readSwarmPilotSpec(load('swarm.json'));
    const control = validateUniverseManifest(load('frontier.json'));
    expect(pilot.files).toHaveLength(3);
    expect(pilot.baselineUsdEstimate).toBeNull();
    expect(pilot.seed).toEqual(control.seed);
    expect(pilot.oracles[pilot.integrationOracle]?.command).toEqual(control.evaluation.command);
    expect(control.variants[0]?.generation).toMatchObject({ poolDigest, allowedWorkerIds: ['frontier'], files: pilot.files });
    const runOracle = (command: string[]) => JSON.parse(execFileSync(command[0]!, command.slice(1), {
      encoding: 'utf8', env: { ASHLR_UNIVERSE_CANDIDATE: pilot.seed.repo },
    }));
    expect(Object.keys(pilot.oracles)).toHaveLength(4);
    for (const oracle of Object.values(pilot.oracles)) {
      expect(evaluationExecutableDigest(oracle.command[0]!)).toBe(oracle.executableDigest);
      expect(runOracle(oracle.command)).toMatchObject({ passed: false });
    }
    for (const file of pilot.files) writeFileSync(join(pilot.seed.repo, file), 'status=ready\n');
    for (const oracle of Object.values(pilot.oracles)) expect(runOracle(oracle.command)).toMatchObject({ passed: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
