import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SeatAdvice, SeatAdviceOption } from '../../../../core/verse/multimodel/types.js';
import { classifyPrompt } from '../../../../core/verse/multimodel/classify.js';
import { session } from '../fixtures.test-support.js';
import { CompareDialog } from './CompareDialog.js';
import { DEFAULT_FLOW_API } from './multimodel-flows.js';

vi.mock('../useVerseSession.js', () => ({ useVerseSession: () => ({ session: null }) }));
vi.mock('../useVerseTranscript.js', () => ({ useVerseTranscript: () => ({ items: [], live: false }) }));
afterEach(() => { vi.unstubAllGlobals(); });
const choice: SeatAdviceOption = { seatId: 'codex-one', engine: 'codex', model: 'gpt-5.5', label: 'Selected Codex', local: false,
  note: 'synthetic', contextMode: 'expansive', contextWindow: 1_000_000 };
const other: SeatAdviceOption = { seatId: 'claude-two', engine: 'claude', model: 'claude-opus-5-5', label: 'Selected Claude', local: false,
  note: 'synthetic', contextMode: 'standard', contextWindow: 200_000 };
const advice: SeatAdvice = { choice, stay: false, why: 'synthetic', factors: [], alternatives: [other], held: [],
  classification: classifyPrompt('question'), mode: 'auto', localOnly: { on: false, reason: null }, routerWhy: 'synthetic' };
function fixture() {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network from inert test'); }));
  const create = vi.spyOn(DEFAULT_FLOW_API, 'createSession').mockImplementation(async (req) => session({ id: 'created-' + req.seatId,
    seatId: req.seatId, model: req.model!, contextMode: req.contextMode ?? 'standard', turnCount: 0 }));
  const handoff = vi.spyOn(DEFAULT_FLOW_API, 'createHandoffSession').mockImplementation(async (req) => session({ id: 'created-' + req.seatId,
    seatId: req.seatId, model: req.model!, contextMode: req.contextMode ?? 'standard', turnCount: 0 }));
  vi.spyOn(DEFAULT_FLOW_API, 'fetchHandoffPreview').mockResolvedValue({ sourceSessionId: 'vs_1', sourceTitle: 'Synthetic', text: 'SYNTHETIC NOTE',
    stats: { chars: 14, estTokens: 4, turnsCovered: 1, filesTouched: 0, truncated: [] } });
  const send = vi.spyOn(DEFAULT_FLOW_API, 'sendTurn').mockResolvedValue({});
  vi.spyOn(DEFAULT_FLOW_API, 'link').mockResolvedValue(true);
  vi.spyOn(DEFAULT_FLOW_API, 'outcome').mockResolvedValue(true);
  return { create, handoff, send };
}
describe('actual dialog selected context propagation', () => {
  it.each([0, 3])('Compare forwards its advisor mode before ordinary turns (history=%s)', async (turnCount) => {
    const api = fixture();
    render(<CompareDialog mode="compare" prompt="Synthetic only" source={session({ turnCount })} seats={[]} advisorSeats={[]} advice={advice}
      onStarted={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send to 2 seats' }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(turnCount ? api.handoff : api.create).toHaveBeenCalledWith(expect.objectContaining({ seatId: choice.seatId, contextMode: 'expansive' }));
    expect(fetch).not.toHaveBeenCalled();
  });
  it('review forwards its exact advised mode through ordinary creation', async () => {
    const api = fixture();
    render(<CompareDialog mode="review" reviewer={choice} question="Synthetic question" answer="Synthetic answer" authorLabel="Synthetic author"
      source={session()} seats={[]} advisorSeats={[]} advice={advice} onStarted={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ seatId: choice.seatId, contextMode: 'expansive' }));
    expect(fetch).not.toHaveBeenCalled();
  });
});
