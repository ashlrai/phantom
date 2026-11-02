export function laneHeldText(
  lane: { lane: string; held: boolean; heldReason: string | null },
  codexPersonal: { resetsAt: string | null } | null,
): string | null {
  if (!lane.held) return null;
  const reason = lane.heldReason?.replace(/\S{32,}/g, '[redacted]').trim().slice(0, 60).trim();
  let text = reason ? `held: ${reason}` : 'held';
  const reset = codexPersonal?.resetsAt ? new Date(codexPersonal.resetsAt) : null;
  if (lane.lane === 'codex-personal' && reset && Number.isFinite(reset.getTime())) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(reset);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
    text += ` · resumes ${part('month')} ${part('day')} ${part('hour')}:${part('minute')} ET`;
  }
  return text;
}
