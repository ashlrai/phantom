/** Hermetic FAKE print-mode engine. Records predicates, never environment values. */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { clearInterval, setInterval } from 'node:timers';

const [mode, recordPath, ...argv] = process.argv.slice(2);
const instruction = argv.at(-1);
const prefix = 'Read the host prompt file at ';
const suffix = ' and follow its host instructions.';
const promptPath = JSON.parse(instruction.slice(prefix.length, -suffix.length));
const prompt = readFileSync(promptPath, 'utf8');
const forbidden = ['GH_TOKEN', 'GITHUB_TOKEN', 'gh_token', 'github_token', 'LOCUS_CONTROL_CAPABILITY', 'ANTHROPIC_API_KEY'];
writeFileSync(recordPath, JSON.stringify({
  argv, promptPath, prompt, cwd: process.cwd(),
  mode: statSync(promptPath).mode & 0o777,
  directoryMode: statSync(dirname(promptPath)).mode & 0o777,
  credentialsAbsent: forbidden.every(key => process.env[key] === undefined),
}));

if (mode === 'reply') process.stdout.write('FAKE bus reply ✓\n');
else if (mode === 'fail') {
  process.stdout.write('partial reply must not ship');
  process.stderr.write('FAKE private diagnostic must not ship');
  process.exitCode = 7;
} else if (mode === 'empty') process.stdout.write('  \n');
else if (mode === 'flood') process.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1, 'x'));
else if (mode === 'stderr-flood') process.stderr.write(Buffer.alloc(4 * 1024 * 1024 + 1, 'x'));
else if (mode === 'redact') {
  // FAKE token-shaped fixture generated at runtime, never a literal repository credential.
  process.stdout.write(['ghp', 'FAKE' + 'x'.repeat(40)].join('_'));
} else if (mode === 'tree') {
  const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  writeFileSync(`${recordPath}.pids`, JSON.stringify({ leader: process.pid, descendant: descendant.pid }));
  setInterval(() => {}, 1000);
} else if (mode === 'silent' || mode === 'ignore-term') {
  if (mode === 'ignore-term') process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'heartbeat' || mode === 'forever') {
  let ticks = 0;
  const timer = setInterval(() => {
    process.stderr.write('FAKE progress\n');
    ticks += 1;
    if (mode === 'heartbeat' && ticks === 16) {
      clearInterval(timer);
      process.stdout.write('FAKE completed after progress\n');
    }
  }, 50);
}
