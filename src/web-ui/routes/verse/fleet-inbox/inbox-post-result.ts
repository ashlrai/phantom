import { ApiError } from '../../../data/client.js';

export function retryable(error: unknown): boolean {
  if (error instanceof ApiError) return [502, 503, 504].includes(error.status);
  return error instanceof TypeError;
}
