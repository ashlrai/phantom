import { afterEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cmdDesktopUpdate, parseDesktopUpdateArgs, desktopUpdateJsonWriter } from '../src/cli/desktop-update.js';
import { cmdDesktop } from '../src/cli/desktop.js';
import * as releaseTrain from '../src/core/release/train.js';
import { readDesktopHostInterlockCensus } from '../src/core/desktop/host-update-interlock.js';
import type { DesktopUpdateDependencies } from '../src/core/desktop/qualified-update.js';

afterEach(()=>vi.restoreAllMocks());
const dependencies:DesktopUpdateDependencies={home:'/private/owned',platform:'darwin',architecture:'arm64',packageRoot:'/owned/package',trust:null,
  admission:()=>{throw new Error('unexpected admission');},currentPackageRoot:()=>null,captureParent:()=>null,verifyParent:async()=>false,parentState:()=> 'unknown',now:Date.now,sleep:async()=>{},
  download:async()=>{throw new Error('network forbidden');}};
describe('installed desktop-update CLI contract',()=>{
  it('does not treat an older dispatcher or unverified census program as an idle host', () => {
    const home = mkdtempSync(join(tmpdir(), 'desktop-host-census-'));
    const run = vi.fn(() => ({schema:'phantom.desktop-update-interlock.v1',activeJobs:2,unknown:0}));
    try {
      expect(readDesktopHostInterlockCensus(home, run).state).toBe('absent');
      const bin = join(home, '.ashlr-runs', 'bin');
      mkdirSync(bin, {recursive:true, mode:0o700});
      for (const [src, name] of [
        ['dispatchd.py', 'dispatchd.py'],
        ['host-integration/launch.candidate.sh', 'launch.sh'],
        ['batch-launch.sh', 'batch-launch.sh'],
        ['local_job.py', 'local_job.py'],
        ['release-autorun.sh', 'release-autorun.sh'],
        ['desktop_update_interlock.py', 'desktop_update_interlock.py'],
        ['process_snapshot.py', 'process_snapshot.py'],
      ]) copyFileSync(join('contrib', 'mac', src!), join(bin, name!));
      expect(readDesktopHostInterlockCensus(home, run)).toEqual({state:'supported',activeJobs:2,unknown:0});
      expect(readDesktopHostInterlockCensus(home, () => null)).toEqual({state:'supported',activeJobs:0,unknown:1});
      run.mockClear();
      writeFileSync(join(bin, 'dispatchd.py'), '#!/usr/bin/python3\n');
      expect(readDesktopHostInterlockCensus(home, run)).toEqual({state:'unsupported',activeJobs:0,unknown:1});
      expect(run).not.toHaveBeenCalled();
      writeFileSync(join(bin, 'dispatchd.py'), '# phantom.desktop-update-interlock.v1\n');
      expect(readDesktopHostInterlockCensus(home, run)).toEqual({state:'unsupported',activeJobs:0,unknown:1});
      expect(run).not.toHaveBeenCalled();
      copyFileSync(join('contrib', 'mac', 'dispatchd.py'), join(bin, 'dispatchd.py'));
      writeFileSync(join(bin, 'desktop_update_interlock.py'), '# phantom.desktop-update-interlock.v1\n');
      expect(readDesktopHostInterlockCensus(home, run).state).toBe('unsupported');
      expect(run).not.toHaveBeenCalled();
    } finally {
      rmSync(home, {recursive:true, force:true});
    }
  });
  it('reports manual-only update drain and read-only hosted pause status', async () => {
    const hosted = vi.spyOn(releaseTrain, 'readHostedReleaseTrainPause').mockReturnValue('paused');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDesktop(['update', 'status', '--json'])).toBe(0);
    expect(hosted).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
      schema: 'desktop.native-update-status.v1',
      drain: {automaticDrain: false, reason: 'drain-interlock-unsupported'},
      hostedReleaseTrain: 'paused',
    });
  });
  it.each(['inspect','prepare','apply'] as const)('accepts the fixed %s opaque-ID JSON request',verb=>{
    expect(parseDesktopUpdateArgs([verb,'--stage','a'.repeat(32),'--json'])).toEqual({verb,stage:'a'.repeat(32)});
  });
  it.each([
    ['apply','--stage','../path','--json'],['apply','--stage','A'.repeat(32),'--json'],['apply','--stage','a'.repeat(32)],
    ['apply','--stage','a'.repeat(32),'--json','--json'],['apply','--url','https://github.com','--json'],
    ['apply','--stage','a'.repeat(32),'--pid','42','--json'],['apply','--stage','a'.repeat(32),'--help'],
    ['inspect','--stage','a'.repeat(32),'--json','--shell','echo'],['unknown','--stage','a'.repeat(32),'--json'],
  ])('refuses ambiguity or caller authority %j',args=>expect(()=>parseDesktopUpdateArgs(args)).toThrow());
  it('handles help without dependency or transport reads',async()=>{
    const log=vi.spyOn(console,'log').mockImplementation(()=>{});expect(await cmdDesktopUpdate(['--help'],dependencies)).toBe(0);
    expect(log).toHaveBeenCalledOnce();expect(log.mock.calls[0]?.[0]).toContain('No URL, path, shell');
  });
  it.each(['inspect','prepare','apply'])('outputs only fixed blocked metadata when trust unavailable (%s)',async verb=>{
    const emit=vi.fn();expect(await cmdDesktopUpdate([verb,'--stage','a'.repeat(32),'--json'],dependencies,emit)).toBe(1);
    expect(emit).toHaveBeenCalledOnce();expect(emit).toHaveBeenCalledWith({schema:'phantom-desktop-update-result/v1',state:'blocked',version:null,reason:'trust-not-commissioned',requiresReapproval:false});
  });
  it('awaits actual stream writes and consumes only its own closed-pipe error lifecycle',async()=>{
    const stream=new Writable({write(_chunk,_encoding,callback){callback(Object.assign(new Error('closed'),{code:'EPIPE'}));}});
    const writer=desktopUpdateJsonWriter(stream);
    expect(stream.listenerCount('error')).toBe(1);
    await expect(writer.write({schema:'phantom-desktop-update-result/v1',state:'blocked',version:null,reason:'trust-not-commissioned',requiresReapproval:false})).rejects.toMatchObject({code:'EPIPE'});
    await writer.dispose();expect(stream.listenerCount('error')).toBe(0);
  });
  it('does not silently swallow an unrelated JSON output failure',async()=>{
    const error=vi.spyOn(console,'error').mockImplementation(()=>{});
    expect(await cmdDesktopUpdate(['inspect','--stage','a'.repeat(32),'--json'],dependencies,async()=>{throw Object.assign(new Error('private test reason'),{code:'EIO'});})).toBe(1);
    expect(error).toHaveBeenCalledWith('Desktop update result channel failed.');
  });
  it('returns usage 2 with no inspection for unsupported operands',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});const emit=vi.fn();expect(await cmdDesktopUpdate(['apply','--path','/tmp','--json'],dependencies,emit)).toBe(2);expect(emit).not.toHaveBeenCalled();
  });
});
