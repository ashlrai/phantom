#!/usr/bin/env node
// Post-build release self-check: run `phm desktop self check` against the
// built console. It never blocks a release on a missing GUI: with no GUI
// session, or no Phantom window to drive, it records a skip and the reason.
//
//   node scripts/release-self-check.mjs --detect   # writes available/reason to $GITHUB_OUTPUT
//   node scripts/release-self-check.mjs --run      # runs the check (needs `npm run build`)
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Codes from the self-surface that mean "nothing to drive here", not a UI regression. */
export const SKIP_CODES = new Set(['no_console', 'no_client', 'killed', 'comms_paused']);

/** Whether this machine has a GUI session a Phantom window could render in. */
export function detectGui({ env = process.env, platform = process.platform, macSession = () => macGuiSession() } = {}) {
  if (env.PHM_SELF_CHECK_HEADLESS === '1') return { available: false, reason: 'PHM_SELF_CHECK_HEADLESS=1 is set.' };
  if (platform === 'linux') {
    return env.DISPLAY || env.WAYLAND_DISPLAY
      ? { available: true, reason: 'X11 or Wayland display is set.' }
      : { available: false, reason: 'Headless Linux: neither DISPLAY nor WAYLAND_DISPLAY is set.' };
  }
  if (platform === 'darwin') {
    const session = macSession();
    return session === 'Aqua'
      ? { available: true, reason: 'macOS Aqua session.' }
      : { available: false, reason: `Headless macOS: launchd session is ${session || 'unknown'}, not Aqua.` };
  }
  if (platform === 'win32') {
    return env.SESSIONNAME && env.SESSIONNAME !== 'Services'
      ? { available: true, reason: `Windows session ${env.SESSIONNAME}.` }
      : { available: false, reason: 'Headless Windows: no interactive session (SESSIONNAME unset or Services).' };
  }
  return { available: false, reason: `No GUI detection for platform ${platform}.` };
}

function macGuiSession() {
  const r = spawnSync('launchctl', ['managername'], { encoding: 'utf8', timeout: 5_000 });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** Turn `phm desktop self check --json` output into pass, skip or fail. */
export function classify(stdout) {
  let result;
  try { result = JSON.parse(stdout); } catch { return { outcome: 'fail', reason: 'self check printed no JSON result.', lines: [] }; }
  if (result && result.schema === 'phantom.self-check.v1') {
    const screens = Array.isArray(result.screens) ? result.screens : [];
    const lines = screens.map((s) => `${s.section}: ${s.ok ? 'ok' : s.flags.join('; ')}${s.loadMs == null ? '' : ` (${s.loadMs} ms)`}`);
    return result.ok
      ? { outcome: 'pass', reason: `All ${screens.length} screens passed.`, lines }
      : { outcome: 'fail', reason: `${screens.filter((s) => !s.ok).length} of ${screens.length} screens flagged.`, lines };
  }
  if (result && result.ok === false && SKIP_CODES.has(result.code)) {
    return { outcome: 'skip', reason: `${result.code}: ${result.error}`, lines: [] };
  }
  return { outcome: 'fail', reason: result && result.error ? `${result.code ?? 'error'}: ${result.error}` : 'unexpected self check result.', lines: [] };
}

function summary(title, reason, lines = []) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `### ${title}\n\n${reason}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`);
}

function output(values) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ')}`).join('\n') + '\n');
}

function main(argv) {
  if (argv.includes('--detect')) {
    const gui = detectGui();
    output({ available: gui.available, reason: gui.reason });
    if (!gui.available) {
      console.log(`::notice title=Self-check skipped::${gui.reason}`);
      summary('Self-check skipped', gui.reason);
    } else console.log(`GUI available: ${gui.reason}`);
    return 0;
  }
  if (argv.includes('--run')) {
    const r = spawnSync(process.execPath, ['bin/ashlr', 'desktop', 'self', 'check', '--json'], { encoding: 'utf8', timeout: 5 * 60_000, env: { ...process.env, NO_COLOR: '1' } });
    const verdict = classify(r.stdout ?? '');
    if (verdict.outcome === 'skip') {
      console.log(`::notice title=Self-check skipped::${verdict.reason}`);
      summary('Self-check skipped', verdict.reason);
      return 0;
    }
    for (const line of verdict.lines) console.log(line);
    summary(verdict.outcome === 'pass' ? 'Self-check passed' : 'Self-check flagged screens', verdict.reason, verdict.lines);
    if (verdict.outcome === 'pass') return 0;
    console.log(`::error title=Self-check failed::${verdict.reason}`);
    return 1;
  }
  console.error('usage: node scripts/release-self-check.mjs --detect|--run');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
