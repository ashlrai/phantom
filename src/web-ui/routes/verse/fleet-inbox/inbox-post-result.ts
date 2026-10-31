import { ApiError } from '../../../data/client.js';

export function postResultText(result: { at: string; duplicate: boolean }, nowLocale?: string): string {
  if (result.duplicate) return 'Already in the inbox · sent within the last 10 minutes';
  const date = new Date(result.at);
  if (!Number.isFinite(date.getTime())) return 'Sent';
  return `Sent · ${new Intl.DateTimeFormat(nowLocale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)}`;
}

export function retryable(error: unknown): boolean {
  if (error instanceof ApiError) return [502, 503, 504].includes(error.status);
  return error instanceof TypeError;
}
