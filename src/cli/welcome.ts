/**
 * `ashlr welcome [--json] [--done <step>|--skip <step>|--dismiss]` — the first-run
 * wizard. Interactive in a TTY: walks each open step, offering to run it.
 */
import { createInterface } from 'node:readline/promises';
import { loadWizard, markFirstRun, type WizardStepId, type WizardV1 } from '../core/firstrun/wizard.js';
import { isTty, makeColors } from './ui.js';

const STEPS: WizardStepId[] = ['github', 'ecosystem', 'budget', 'notifications', 'autonomy'];

export function renderWizard(w: WizardV1, tty = isTty()): string {
  const { bold, green, dim, cyan } = makeColors(tty);
  const L = ['', `  ${bold('Welcome to Phantom')} ${dim(w.complete ? '— all set' : `— ${w.steps.filter((s) => s.state === 'done').length}/${w.steps.length} done`)}`, ''];
  w.steps.forEach((s, i) => {
    const mark = s.state === 'done' ? green('✓') : s.state === 'skipped' ? dim('–') : '○';
    L.push(`  ${mark} ${i + 1}. ${bold(s.title)}  ${dim(s.why)}`);
    if (s.state === 'todo') L.push(`       ${cyan(s.command)}`);
  });
  L.push('', w.next ? `  Next: ${cyan(w.next.command)}   ${dim('(or open the console: ashlr serve → Today)')}` : `  ${green('Done.')} ${dim('`ashlr home` shows your day.')}`, '');
  return L.join('\n');
}

export async function cmdWelcome(args: string[]): Promise<number> {
  const json = args.includes('--json');
  for (const flag of ['--done', '--skip'] as const) {
    const i = args.indexOf(flag);
    if (i >= 0) {
      const id = args[i + 1] as WizardStepId;
      if (!STEPS.includes(id)) { process.stderr.write(`${flag} needs one of: ${STEPS.join(', ')}\n`); return 2; }
      markFirstRun(id, flag === '--done' ? 'finished' : 'skipped');
    }
  }
  if (args.includes('--dismiss')) markFirstRun('dismiss', 'finished');
  let w = await loadWizard();
  if (json || !process.stdin.isTTY || w.complete) { process.stdout.write(json ? `${JSON.stringify(w, null, 2)}\n` : renderWizard(w)); return 0; }
  process.stdout.write(renderWizard(w));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const s of w.steps.filter((x) => x.state === 'todo')) {
      const a = (await rl.question(`  ${s.title}? [r]un  [s]kip  [q]uit  `)).trim().toLowerCase();
      if (a.startsWith('q')) break;
      if (a.startsWith('s')) { markFirstRun(s.id, 'skipped'); continue; }
      if (s.id === 'budget') {
        const v = (await rl.question('  Daily metered budget in USD (0 = subscriptions/local only): ')).trim();
        const { cmdSettings } = await import('./settings.js');
        if ((await cmdSettings(['set', 'budget.dailyUsd', v || '0'])) === 0) markFirstRun('budget', 'finished');
      } else if (s.id === 'notifications') {
        const { cmdSettings } = await import('./settings.js');
        const v = (await rl.question('  Desktop notification when something needs you? [Y/n] ')).trim();
        if ((await cmdSettings(['set', 'notifications.desktop', /^n/i.test(v) ? 'off' : 'on'])) === 0) markFirstRun('notifications', 'finished');
      } else if (s.id === 'ecosystem') {
        rl.pause();
        const { cmdEcosystemUp } = await import('./ecosystem-up.js');
        await cmdEcosystemUp(['up']);
        rl.resume();
      } else if (s.id === 'autonomy') {
        const { cmdSettings } = await import('./settings.js');
        await cmdSettings(['set', 'autonomy.level', 'autonomous']);
      } else {
        process.stdout.write(`  Run: ${s.command}\n`);
      }
    }
  } finally { rl.close(); }
  w = await loadWizard();
  process.stdout.write(renderWizard(w));
  return 0;
}
