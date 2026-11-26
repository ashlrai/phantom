import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [directory, githubRepo, frontier, local, poolId, poolDigest] = process.argv.slice(2);
const id = /^[a-z0-9][a-z0-9_-]{0,63}$/;
if (!directory || !/^[\w-]+\/[\w.-]+$/.test(githubRepo ?? '') ||
    ![frontier, local, poolId].every(value => id.test(value ?? '')) || frontier === local ||
    !/^[a-f0-9]{64}$/.test(poolDigest ?? '')) {
  throw new Error('Usage: node swarm-pilot-mac.mjs DIRECTORY OWNER/REPO FRONTIER_WORKER LOCAL_WORKER POOL_ID POOL_DIGEST');
}

const root = realpathSync(directory);
const repo = join(root, 'seed');
const oracleDir = join(root, 'oracles');
mkdirSync(repo, { mode: 0o700 });
mkdirSync(oracleDir, { mode: 0o700 });
const files = ['router.conf', 'worker.conf', 'reporter.conf'];
for (const file of files) writeFileSync(join(repo, file), 'status=active\n');
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
git('init', '-b', 'main');
git('add', '--', ...files);
git('-c', 'user.name=Swarm Pilot Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Seed status fixtures');
const seed = { repo, revision: git('rev-parse', 'HEAD') };
const goal = 'Rename the status value from active to ready in router.conf, worker.conf, and reporter.conf. Keep exactly one newline-terminated status=ready line per file. Assign one independent fast task per file using its matching leaf oracle.';
const oracles = {};
for (const [name, paths] of [...files.map(file => [file.split('.')[0], [file]]), ['integration', files]]) {
  const exe = join(oracleDir, name);
  const checks = paths.map(file => `printf '%s\\n' status=ready | /usr/bin/cmp -s - "$ASHLR_UNIVERSE_CANDIDATE/${file}"`);
  const script = `#!/bin/sh\nif ${checks.join(' && ')}; then\n  printf '%s\\n' '{"passed":true,"score":1,"metrics":{}}'\nelse\n  printf '%s\\n' '{"passed":false,"score":0,"metrics":{}}'\nfi\n`;
  writeFileSync(exe, script, { mode: 0o500, flag: 'wx' });
  oracles[name] = { command: [exe], executableDigest: createHash('sha256').update(script).digest('hex') };
}

const write = (name, value) => writeFileSync(join(root, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
write('swarm.json', { id: 'mac-swarm', goal, seed, githubRepo, planner: { workerId: frontier, tier: 'frontier' },
  workers: [{ workerId: local, tier: 'fast' }], files, oracles, integrationOracle: 'integration', baselineUsdEstimate: null });
write('frontier.json', { schemaVersion: 1, id: 'mac-frontier', name: 'One-Mac frontier control', objective: goal, seed,
  metric: { name: 'oracle', direction: 'maximize', minImprovement: 0 },
  evaluation: { command: oracles.integration.command, timeoutMs: 30_000 },
  budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 300_000, trialTimeoutMs: 300_000 },
  variants: [{ id: 'frontier', niche: 'frontier', hypothesis: 'Make the entire change in one attempt.',
    generation: { kind: 'resource-pool', poolId, poolDigest, allowedWorkerIds: [frontier], files, maxOutputTokens: 8_192 } }] });
console.log(JSON.stringify({ seed, swarm: join(root, 'swarm.json'), frontier: join(root, 'frontier.json') }));
