import { createInterface } from 'node:readline/promises';
import { detectEcosystem } from '../core/onboard/ecosystem.js';
import { EcosystemGrantError, grantEcosystem } from '../core/onboard/ecosystem-grant.js';

const HELP = `Usage: phm onboard --ecosystem [--json]
       phm onboard --ecosystem --grant --plan <planId> --select <id,id,...> [--json]

Detect existing capabilities without credentials. Interactive mode offers toggles
and one bundle approval. Non-TTY and --json preview only unless --grant includes
the reviewed planId and explicit capability ids. --yes never grants this bundle.
Imports stay in Phantom Secrets' trusted terminal. No TCC or runtime activation.`;

export async function cmdOnboardEcosystem(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  try {
    const allowed = new Set(['--ecosystem', '--json', '--grant', '--plan', '--select', '--help', '-h', '--yes']);
    for (let i = 0; i < args.length; i++) {
      if (!allowed.has(args[i]!)) throw new EcosystemGrantError('Unknown ecosystem option. Run phm onboard --ecosystem --help.');
      if (args[i] === '--plan' || args[i] === '--select') {
        if (!args[++i] || args[i]!.startsWith('--')) throw new EcosystemGrantError('Missing option value. Run phm onboard --ecosystem --help.');
      }
    }
    if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
    const option = (name: string) => args[args.indexOf(name) + 1];
    if (args.includes('--grant')) {
      if (!args.includes('--plan') || !args.includes('--select') || args.includes('--yes')) throw new EcosystemGrantError('A grant needs --plan and --select; --yes is not bundle approval.');
      const receipt = await grantEcosystem({ planId: option('--plan'), selected: option('--select')!.split(',') });
      if (json) emit(receipt);
      else for (const row of receipt.results) console.log(`${row.id}: ${row.status}. ${row.detail}${row.next ? ` Next: ${row.next}` : ''}`);
      return receipt.phase === 'complete' ? 0 : 1;
    }
    if (args.includes('--plan') || args.includes('--select')) throw new EcosystemGrantError('--plan and --select require --grant.');
    const plan = await detectEcosystem();
    if (json) { emit(plan); return 0; }
    console.log('Ecosystem onboarding');
    for (const row of plan.capabilities) console.log(`[${row.selected ? 'x' : ' '}] ${row.id}: ${row.label} (${row.state})${row.names.length ? `: ${row.names.join(', ')}` : ''}${row.next ? `\n    ${row.next}` : ''}`);
    console.log(`Plan: ${plan.planId}`);
    if (!process.stdin.isTTY || args.includes('--yes')) {
      console.log('Approve a reviewed selection: phm onboard --ecosystem --grant --plan <planId> --select <id,id> --json');
      return 0;
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const toggles = await prompt.question('Toggle capability ids (comma separated), or Enter for detected defaults: ');
      const selected = new Set(plan.capabilities.filter(row => row.selected).map(row => row.id));
      for (const id of toggles.split(',').map(id => id.trim()).filter(Boolean)) {
        if (!plan.capabilities.some(row => row.id === id)) throw new EcosystemGrantError('Unknown capability id; no grant applied.');
        if (selected.has(id)) selected.delete(id); else selected.add(id);
      }
      console.log(`Selected: ${[...selected].join(', ')}`);
      const answer = await prompt.question('Grant this integration bundle? [y/N] ');
      if (answer.trim().toLowerCase() !== 'y') { console.log('No integration grant applied.'); return 0; }
      const receipt = await grantEcosystem({ planId: plan.planId, selected: [...selected] });
      for (const row of receipt.results) console.log(`${row.id}: ${row.status}. ${row.detail}${row.next ? ` Next: ${row.next}` : ''}`);
      return receipt.phase === 'complete' ? 0 : 1;
    } finally { prompt.close(); }
  } catch (error) {
    const message = error instanceof EcosystemGrantError ? error.message : 'Ecosystem onboarding is unavailable. Check local file permissions and retry.';
    if (json) emit({ ok: false, error: message }); else console.error(message);
    return 2;
  }
}
