/** Compact agent activity for the phone. An unreadable payload is null, not an empty list. */

export interface PhoneActivitySummary {
  running: Array<{ sessionId: string; title: string }>;
  recent: Array<{ sessionId: string; title: string; outcome: string; at: string }>;
}

function row(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function summarizePhoneActivity(raw: unknown): PhoneActivitySummary | null {
  const body = row(raw);
  if (!body || !Array.isArray(body.running) || !Array.isArray(body.completions)) return null;
  const running: PhoneActivitySummary['running'] = [];
  for (const item of body.running) {
    const record = row(item);
    if (!record || typeof record.sessionId !== 'string' || typeof record.title !== 'string') return null;
    running.push({ sessionId: record.sessionId, title: record.title });
  }
  const recent: PhoneActivitySummary['recent'] = [];
  for (const item of body.completions) {
    const record = row(item);
    if (!record || typeof record.sessionId !== 'string' || typeof record.title !== 'string'
      || typeof record.outcome !== 'string' || typeof record.at !== 'string') return null;
    recent.push({ sessionId: record.sessionId, title: record.title, outcome: record.outcome, at: record.at });
  }
  return { running, recent };
}
