import { describe, expect, it } from 'vitest';
import { updateImpact } from './update-impact.js';

describe('updateImpact', () => {
  it('describes separate workers', () => expect(updateImpact(2, true, true)).toEqual({ text: '2 fleet jobs running. Installing restarts only the app; jobs keep running.', tone: 'ok' }));
  it.each([false, null])('warns when process separation is %s', outside => expect(updateImpact(2, outside, true)).toEqual({ text: '2 fleet jobs running. Unknown whether a restart interrupts them.', tone: 'warn' }));
  it('reports an idle fleet', () => expect(updateImpact(0, null, true)).toEqual({ text: 'No fleet jobs running.', tone: 'ok' }));
  it('does not invent a count', () => expect(updateImpact(null, true, true)?.tone).toBe('warn'));
  it('hides the line without an update', () => expect(updateImpact(2, true, false)).toBeNull());
});
