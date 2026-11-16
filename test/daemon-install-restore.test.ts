import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ context: vi.fn(), refusal: vi.fn(), authority: vi.fn() }));
vi.mock('../src/core/authority/resident.js', () => ({ currentOperatorContext: mocks.context, operatorContextRefusal: mocks.refusal }));
vi.mock('../src/cli/authority.js', () => ({ runAuthorityCli: mocks.authority }));
import { cmdDaemon } from '../src/cli/daemon.js';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  vi.clearAllMocks(); Object.defineProperty(process, 'platform', { value: 'darwin' });
  mocks.context.mockReturnValue({}); mocks.refusal.mockReturnValue(null); mocks.authority.mockResolvedValue(0);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks(); });
it('restores macOS install through the grant and confirmation enforcing command, with no --yes bypass', async () => {
  expect(await cmdDaemon(['install'])).toBe(0);
  expect(mocks.authority).toHaveBeenCalledExactlyOnceWith(['resident', 'start']);
});
it('propagates authority refusal without retrying a legacy installer', async () => {
  mocks.authority.mockResolvedValue(1); expect(await cmdDaemon(['install'])).toBe(1);
  expect(mocks.authority).toHaveBeenCalledTimes(1);
});
it('keeps autonomous and redirected-home installs denied', async () => {
  mocks.refusal.mockReturnValue('not the operator'); expect(await cmdDaemon(['install'])).toBe(1);
  expect(mocks.authority).not.toHaveBeenCalled();
});
it('keeps --no-autostart and non-macOS legacy install paths denied', async () => {
  expect(await cmdDaemon(['install', '--no-autostart'])).toBe(1);
  Object.defineProperty(process, 'platform', { value: 'linux' }); expect(await cmdDaemon(['install'])).toBe(1);
  expect(mocks.authority).not.toHaveBeenCalled();
});
