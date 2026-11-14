import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QUEUE_TIERS, QUEUE_TIER_SCOPE } from '../src/core/drive/queue-tier.js';

const restock = new URL('../contrib/mac/restock.py', import.meta.url);
const launcher = readFileSync(new URL('../contrib/mac/host-integration/launch.candidate.sh', import.meta.url), 'utf8');
// Execute only the actual prompt builder and its constants, with no host I/O.
const python = `import ast,json,pathlib,sys
tree=ast.parse(pathlib.Path(sys.argv[1]).read_text())
nodes=[n for n in tree.body if (isinstance(n,ast.FunctionDef) and n.name=='prompt_body') or
       (isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id in ('SCOPE_BUDGETS','PIN_MERGE') for t in n.targets))]
ns={}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'<prompt>','exec'),ns)
tier,lane=sys.argv[2:]
print(json.dumps({'budgets':ns['SCOPE_BUDGETS'],'prompt':ns['prompt_body']('RQ-FIXTURE','phantom',lane,tier,
 'max-files=10, size<=100','Finish src/a.ts; no merge without Security pin',gate=['RQ-DEP'])}))
`;
const shell = launcher.split('# BEGIN TIER SCOPE:')[1]!.split('# END TIER SCOPE')[0]!.split('\n').slice(1).join('\n');
const shellEnv = { HOME: process.env.HOME!, PATH: '/usr/bin:/bin' };

describe('tier delegation briefs across the Mac prompt builders', () => {
  it.each(QUEUE_TIERS)('emits matching %s budgets and complete-feature acceptance', tier => {
    const result = JSON.parse(execFileSync('python3', ['-I', '-B', '-c', python, restock.pathname, tier, 'devin'], { encoding: 'utf8' }));
    expect(result.budgets).toEqual(QUEUE_TIER_SCOPE);
    const scope = QUEUE_TIER_SCOPE[tier];
    const launched = execFileSync('bash', ['--noprofile', '--norc', '-ec', shell], { encoding: 'utf8', env: { ...shellEnv, TIER: tier, POOL: 'devin' } });
    for (const prompt of [result.prompt, launched]) {
      expect(prompt).toContain(`up to ${scope.maxFiles} files, size<=${scope.maxLines}`);
      expect(prompt).toContain('Explicit narrower task limits and named-file restrictions take precedence');
      expect(prompt).toContain('Finish the complete feature, not the minimum demo; add tests, run them, and update docs');
      expect(prompt).toContain('mergeable PR per job');
      expect(prompt.includes('Combine related concerns')).toBe(tier === 'frontier');
    }
    expect(result.prompt).toContain('DEPENDENCY GATE: RQ-DEP');
    expect(result.prompt).toContain('no merge without Security pin');
    expect(result.prompt).toContain('max-files=10, size<=100');
  });

  it('keeps local models on the fast scope even if a row requests frontier', () => {
    const result = JSON.parse(execFileSync('python3', ['-I', '-B', '-c', python, restock.pathname, 'frontier', 'codex-local'], { encoding: 'utf8' }));
    const launched = execFileSync('bash', ['--noprofile', '--norc', '-ec', shell], { encoding: 'utf8', env: { ...shellEnv, TIER: 'frontier', POOL: 'codex-local' } });
    for (const prompt of [result.prompt, launched]) {
      expect(prompt).toContain('up to 2 files, size<=80');
      expect(prompt).not.toContain('Combine related concerns');
    }
  });

  it('refuses unknown tiers in the launcher and restock instead of upgrading them', () => {
    expect(spawnSync('bash', ['--noprofile', '--norc', '-ec', shell], { env: { ...shellEnv, TIER: 'standard', POOL: 'devin' } }).status).toBe(3);
    // Run real restock admission in its existing temporary-home fixture.
    const harness = `import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('fixture',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
rows=[m.line('RQ-BAD-'+str(i),pool='devin',tier=t,repo='phantom') for i,t in enumerate(('standard','frontier-bogus','','frontier, tier=work'))]
tmp=m.build('\\n'.join(rows)+'\\n')
try:
 r=m.restock(pathlib.Path(tmp.name),'--dry-run','--json'); assert r.returncode==0,r.stderr; print(r.stdout)
finally: tmp.cleanup()
`;
    const fixture = new URL('../contrib/mac/tests/test_restock.py', import.meta.url);
    const result = JSON.parse(execFileSync('python3', ['-I', '-B', '-c', harness, fixture.pathname], { encoding: 'utf8' }));
    expect(result.queued).toBe(0);
    expect(result.skips['unknown-tier']).toBe(4);
    expect(result.scope_budgets).toEqual(QUEUE_TIER_SCOPE);
  });
});
