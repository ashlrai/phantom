import { runChangedTests } from '../core/test-changed.js';

const usage = 'Usage: phm test --changed [--base <ref>] [--json]';
export function cmdTest(args: string[]): number {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  let changed = false; let json = false; let base = 'HEAD'; let baseSeen = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--changed' && !changed) changed = true;
    else if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--base' && !baseSeen && args[i + 1] && !args[i + 1]!.startsWith('-')) { base = args[++i]!; baseSeen = true; }
    else { console.error(usage); return 2; }
  }
  if (!changed) { console.error(usage); return 2; }
  try {
    const result = runChangedTests(process.cwd(), base, json);
    if (json) console.log(JSON.stringify(result));
    else console.log(`${result.mode}: ${result.reason}\n${result.tests.join('\n')}`);
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Test selection failed';
    if (json) console.log(JSON.stringify({ error: message, exitCode: 1 })); else console.error(message);
    return 1;
  }
}
