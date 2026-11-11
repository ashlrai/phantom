import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// Load the public function without starting the host dispatcher at module scope.
const execFileAsync = promisify(execFile);
const probe = String.raw`
import ast, json, subprocess, time
from pathlib import Path
from types import SimpleNamespace
path = Path('contrib/mac/host-integration/dispatchd.candidate.py')
tree = ast.parse(path.read_text())
function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'refresh_stale_budget')
calls = []
def run(command, timeout):
    calls.append(command)
    return SimpleNamespace(returncode=0, stdout=json.dumps({'schema':'use-it-all.v1', 'ts':int(time.time()) - 121, 'lanes':{'claude':{'known':True,'stale':False,'behind':True}}}))
scope = {'json':json, 'subprocess':subprocess, 'time':time, 'R':'/tmp', 'UIA_KEYS':('known','stale','behind'), '_run':run}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(path), 'exec'), scope)
refresh = scope['refresh_stale_budget']
fresh = {'known':True, 'stale':False, 'behind':True}
unchanged = refresh('claude', fresh)
expired = refresh('claude', {'known':True, 'stale':True, 'behind':True})
print(json.dumps({'unchanged':unchanged, 'expired':expired, 'calls':len(calls)}))
`;

describe('stale budget refresh', () => {
  it('leaves current evidence alone and refuses an expired refresh', async () => {
    const { stdout } = await execFileAsync('python3', ['-c', probe], { encoding: 'utf8' });
    const result = JSON.parse(stdout);
    expect(result.unchanged).toEqual({ known: true, stale: false, behind: true });
    expect(result.expired).toEqual({ known: false, stale: true, behind: false, reason: 'Usage refresh unavailable' });
    expect(result.calls).toBe(1);
  });
});
