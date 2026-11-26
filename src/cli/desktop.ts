import {applyConsumerDesktopInstall, createConsumerInstallDependencies, inspectConsumerDesktopInstall,
  type ConsumerInstallDependencies, type ConsumerInstallResult} from '../core/desktop/consumer-install.js';
import {cmdDesktopOperator, type DesktopOperatorCliDeps} from './desktop-operator.js';
import {applyConsumerDesktopUpgrade, createConsumerUpgradeDependencies, inspectConsumerDesktopUpgrade,
  approveConsumerDesktopUpdate, retryApprovedConsumerDesktopUpdate,
  type ConsumerUpgradeDependencies, type ConsumerUpgradeOptions, type ConsumerUpgradeResult} from '../core/desktop/consumer-upgrade.js';
import { desktopUpdateInterlockPresent } from '../core/desktop/update-interlock.js';
import { readDesktopHostInterlockCensus } from '../core/desktop/host-update-interlock.js';
import { readHostedReleaseTrainPause } from '../core/release/train.js';
import { realHome } from '../core/real-home.js';

const USAGE = `usage: phm desktop install [--apply]
       phm desktop update status --json
       phm desktop update sign-desktop-update --stage <id>
       phm desktop install --upgrade [--apply] [--require-app] [--to x.y.z]
       phm desktop install --rollback [--apply]
       phm desktop list-apps|windows|focus|read|scroll|type|click|screenshot|doctor [--json]

Inspect this installed CLI's original signed macOS arm64 app and paired CLI.
Inspection downloads verified artifacts into a fresh private stage. Plain --apply
installs only when Phantom/Ashlr.app, the managed current pointer and managed
phm/ashlr links are absent, after explicit authority Stop/drain.
No builds, signing keys, credentials, PATH edits or authority restart.
--upgrade replaces a managed CLI and its verified paired app. On a compatible
host, an unchanged active standing grant can cover unattended drain and resume.
The manual Stop and rollback paths leave restart to the owner.

Operator verbs read and drive macOS apps through the desktop-operator helper.
See docs/DESKTOP-OPERATOR.md. phm desktop <verb> --help prints operator usage.
`;
export function parseDesktopInstallArgs(args: readonly string[]): {apply: boolean; mode?:ConsumerUpgradeOptions['mode']; requireApp?:boolean; to?:string} | null {
  if (!args.length || args.length===1 && ['help','--help','-h'].includes(args[0]!)) return null;
  const invalid=()=>{throw new Error('Invalid desktop install arguments');};
  if(args[0]!=='install')return invalid();
  const flags=new Set<string>();let to:string|undefined;
  for(let i=1;i<args.length;i++) {
    const flag=args[i]!;if(!['--apply','--upgrade','--rollback','--require-app','--to'].includes(flag)||flags.has(flag))return invalid();flags.add(flag);
    if(flag==='--to') {to=args[++i];if(!to||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(to))return invalid();}
  }
  if(flags.has('--rollback')&&(flags.has('--upgrade')||flags.has('--to')||flags.has('--require-app')))return invalid();
  if(!flags.has('--upgrade')&&!flags.has('--rollback')) {if(flags.has('--to')||flags.has('--require-app'))return invalid();return {apply:flags.has('--apply')};}
  return {apply:flags.has('--apply'),mode:flags.has('--rollback')?'rollback':'upgrade',requireApp:flags.has('--require-app'),...(to?{to}:{})};
}
export async function cmdDesktop(args: string[], dependencies?: ConsumerInstallDependencies,
  emit: (result: ConsumerInstallResult|ConsumerUpgradeResult)=>void|Promise<void> = value=>{console.log(JSON.stringify(value));},
  operatorDeps?: DesktopOperatorCliDeps, upgradeDeps?:ConsumerUpgradeDependencies): Promise<number> {
  const head = args[0];
  if (head === 'update') {
    if (args.length === 2 && ['--help', '-h', 'help'].includes(args[1]!)) {console.log(USAGE);return 0;}
    if (args.length===4 && args[1]==='sign-desktop-update' && args[2]==='--stage' && /^[a-f0-9]{32}$/.test(args[3]!)) {
      const result=await approveConsumerDesktopUpdate(upgradeDeps??createConsumerUpgradeDependencies(),args[3]!);
      await emit(result);
      return result.state==='upgraded' || result.scheduleHint ? 0 : 1;
    }
    if (args.length===2 && args[1]==='retry-approved') {
      const result=await retryApprovedConsumerDesktopUpdate(upgradeDeps??createConsumerUpgradeDependencies());
      if (result) await emit(result);
      return result?.scheduleHint ? 75 : 0;
    }
    if (args.length !== 3 || args[1] !== 'status' || args[2] !== '--json') {console.error(USAGE);return 2;}
    const {readNativeUpdateStatus}=await import('../core/desktop/native-update-status.js');
    const home = realHome();
    console.log(JSON.stringify({
      ...readNativeUpdateStatus(),
      drain: {
        automaticDrain: false,
        reason: 'drain-interlock-unsupported',
        localInterlock: desktopUpdateInterlockPresent() ? 'held-or-unreadable' : 'clear',
        ...(process.platform === 'darwin' && {
          hostCensus: home ? readDesktopHostInterlockCensus(home) : {state: 'unsupported', activeJobs: 0, unknown: 1},
        }),
        remedy: 'Engage operator Stop and let local work drain before installing.',
      },
      hostedReleaseTrain: readHostedReleaseTrainPause(),
    }));
    return 0;
  }
  if (head && !['install', 'help', '--help', '-h'].includes(head)) return cmdDesktopOperator(args, operatorDeps);
  let options: ReturnType<typeof parseDesktopInstallArgs>;
  try {options=parseDesktopInstallArgs(args);} catch {console.error(USAGE);return 2;}
  if (!options) {console.log(USAGE);return 0;}
  if(options.mode) {
    try {
      let result=await inspectConsumerDesktopUpgrade(upgradeDeps??createConsumerUpgradeDependencies(),{...options,mode:options.mode,requireApp:options.requireApp??false});
      if(options.apply&&result.state==='ready')result=await applyConsumerDesktopUpgrade(result);
      await emit(result);return ['ready','current','upgraded','reverted'].includes(result.state)?0:1;
    }catch {console.error('Desktop upgrade unavailable.');return 1;}
  }
  let observed: ConsumerInstallResult;
  try {
    const deps=dependencies??createConsumerInstallDependencies();
    observed=await inspectConsumerDesktopInstall(deps,options.apply);
    if (options.apply && observed.state==='ready') observed=await applyConsumerDesktopInstall(observed);
  } catch {
    observed={state:'held',version:null,reason:'consumer-unavailable',installationAccepted:false,authorityResumed:false,shell:[]};
  }
  // A failed output channel cannot retry a completed or held installation.
  try {await emit(observed);} catch {console.error('Desktop installation result channel failed.');return 1;}
  return observed.state==='ready'||observed.state==='installed'?0:1;
}
