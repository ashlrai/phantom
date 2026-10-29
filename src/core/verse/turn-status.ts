/** Deterministic assistant copy; these lines never invoke a model or grant tools. */
export function statusLine(text: string, limit: number): string {
  const line = text.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

export function turnAcknowledgement(task: string): string {
  return `I’m working on: ${statusLine(task, 100)}`;
}

export function turnResult(task: string, answer: string, outcome: 'ok' | 'failed' | 'cancelled'): string {
  const name = statusLine(task, 100);
  if (outcome === 'cancelled') return `Stopped: ${name}`;
  if (outcome === 'failed') return `Turn failed: ${name}`;
  const result = statusLine(answer, 160);
  return result ? `Result for ${name}: ${result}` : `Turn finished: ${name}. No response text was returned.`;
}
