/** Describe delivery without exposing server-provided text. */
export function needsMasonResolvedText(_itemText: string, response: unknown): string {
  const inbox = response !== null && typeof response === 'object' && 'inbox' in response ? response.inbox : undefined;
  if (inbox === 'appended') return 'Resolved. Your reply went to the planner inbox.';
  if (inbox === 'failed') return 'Resolved, but your reply did not reach the planner inbox. Use Tell the leaders to resend it.';
  return 'Resolved.';
}
