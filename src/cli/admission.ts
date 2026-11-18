import { readAdmission, type ReadAdmissionOptions } from '../core/queue/admission.js';

const HELP = 'Usage: phm admission explain [--json]\nRead the adaptive launch interval and inputs. Advisory; the pinned host guard enforces pacing.';

export async function cmdAdmission(args: string[], options: ReadAdmissionOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) { console.log(HELP); return 0; }
  if (args[0] !== 'explain' || args.length > 2 || (args[1] !== undefined && !['--json', '--help', '-h'].includes(args[1]))) {
    console.error(HELP); return 2;
  }
  if (args[1] === '--help' || args[1] === '-h') { console.log(HELP); return 0; }
  const { settle } = await readAdmission(options);
  const report = { schema: 'phantom.admission-explain.v1', readOnly: true, enforced: false, ...settle };
  console.log(args[1] === '--json' ? JSON.stringify(report) : [
    `Launch settle: ${settle.settleSeconds}s (legacy ${settle.legacySeconds}s; adaptive ${settle.enabled ? 'on' : 'off'}).`,
    ...Object.entries(settle.inputs).map(([name, value]) => `${name}=${value ?? 'unknown'}`),
    settle.reason, 'Advisory; host enforcement requires the pinned guard integration.',
  ].join('\n'));
  return 0;
}
