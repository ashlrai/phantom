import { visibleWindows, windowNote } from './provider-windows.js';

export function limitWindowLabel(
  backend: string,
  window: string,
): { text: string; retired: boolean; title: string | null } {
  if (/claude|anthropic/i.test(backend) && visibleWindows('claude', [{ id: window }]).length === 0) {
    return { text: 'per week', retired: true, title: windowNote('claude') };
  }
  return { text: `per ${window.replace(/_/g, ' ')}`, retired: false, title: null };
}
