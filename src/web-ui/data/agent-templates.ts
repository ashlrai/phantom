/** Device-local task recipes. No API client, credentials, or launch authority. */
export interface AgentTemplate {
  id: string;
  name: string;
  title: string;
  prompt: string;
}
const KEY = 'ashlr.verse.agent-templates.v1';
const MAX_TEMPLATES = 100;
function valid(value: unknown): value is AgentTemplate {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 100
    && typeof item.name === 'string' && item.name.trim().length > 0 && item.name.length <= 100
    && typeof item.title === 'string' && item.title.length <= 200
    && typeof item.prompt === 'string' && item.prompt.trim().length > 0 && item.prompt.length <= 20000;
}
export function readAgentTemplates(): AgentTemplate[] {
  const raw = localStorage.getItem(KEY);
  if (raw === null) return [];
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data) || data.length > MAX_TEMPLATES || !data.every(valid)
    || new Set(data.map(item => item.id)).size !== data.length) {
    throw new Error('Invalid template storage');
  }
  return data;
}
export function createAgentTemplate(input: Omit<AgentTemplate, 'id'>): AgentTemplate[] {
  const item = { id: crypto.randomUUID(), name: input.name.trim(), title: input.title.trim(), prompt: input.prompt.trim() };
  if (!valid(item)) throw new Error('Use a name (up to 100 characters), title (up to 200), and task (up to 20,000).');
  const items = readAgentTemplates();
  if (items.length >= MAX_TEMPLATES) throw new Error('The gallery is full. Delete a template first.');
  if (items.some(saved => saved.name.toLocaleLowerCase() === item.name.toLocaleLowerCase())) throw new Error('Choose a unique template name.');
  const next = [...items, item];
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
export function deleteAgentTemplate(id: string): AgentTemplate[] {
  const next = readAgentTemplates().filter(item => item.id !== id);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
