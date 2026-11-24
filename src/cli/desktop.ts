import {applyConsumerDesktopInstall, createConsumerInstallDependencies, inspectConsumerDesktopInstall,
  type ConsumerInstallDependencies, type ConsumerInstallResult} from '../core/desktop/consumer-install.js';
import {cmdDesktopOperator, type DesktopOperatorCliDeps} from './desktop-operator.js';
import {applyConsumerDesktopUpgrade, createConsumerUpgradeDependencies, inspectConsumerDesktopUpgrade,
  type ConsumerUpgradeDependencies, type ConsumerUpgradeOptions, type ConsumerUpgradeResult} from '../core/desktop/consumer-upgrade.js';

const USAGE = `usage: phm desktop install [--apply]
       phm desktop install --upgrade [--apply] [--require-app] [--to x.y.z]
       phm desktop install --rollback [--apply]
       phm desktop list-apps|windows|focus|read|scroll|type|click|screenshot|doctor [--json]

Inspect this installed CLI's original signed macOS arm64 app and paired CLI.
Inspection downloads verified artifacts into a fresh private stage. Plain --apply
installs only when Phantom/Ashlr.app, the managed current pointer and managed
phm/ashlr links are absent, after explicit authority Stop/drain.
No builds, signing keys, credentials, PATH edits or authority restart.
--upgrade replaces only a managed CLI; --rollback selects its journaled previous
release. Both stop the resident before switching and leave restart to the owner.

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
    observed=await inspectConsumerDesktopInstall(deps);
    if (options.apply && observed.state==='ready') observed=await applyConsumerDesktopInstall(observed);
  } catch {
    observed={state:'held',version:null,reason:'consumer-unavailable',installationAccepted:false,authorityResumed:false,shell:[]};
  }
  // A failed output channel cannot retry a completed or held installation.
  try {await emit(observed);} catch {console.error('Desktop installation result channel failed.');return 1;}
  return observed.state==='ready'||observed.state==='installed'?0:1;
}
