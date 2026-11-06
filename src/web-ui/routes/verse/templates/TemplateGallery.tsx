import { useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { Input } from '../../../components/primitives/Input.js';
import { createAgentTemplate, deleteAgentTemplate, readAgentTemplates, type AgentTemplate } from '../../../data/agent-templates.js';
import styles from './TemplateGallery.module.css';

export function TemplateGallery({ title, prompt, disabled, onApply }: {
  title: string; prompt: string; disabled?: boolean; onApply: (template: AgentTemplate) => void;
}) {
  const [name, setName] = useState('');
  const [items, setItems] = useState<AgentTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  function refresh() {
    try { setItems(readAgentTemplates()); setLoaded(true); setError(''); }
    catch { setLoaded(false); setError('Local templates could not be read. Check browser storage access; saved data has been preserved.'); }
  }
  function save() {
    try {
      setItems(createAgentTemplate({ name, title, prompt })); setName(''); setError(''); setNotice('Template saved locally.');
    } catch (cause) {
      setError(cause instanceof Error && !['QuotaExceededError', 'SecurityError', 'SyntaxError'].includes(cause.name)
        ? cause.message : 'Template could not be saved. Check storage access and available space.');
    }
  }
  function remove(id: string) {
    try { setItems(deleteAgentTemplate(id)); setError(''); setNotice('Template deleted locally.'); }
    catch { setError('Template could not be deleted. Saved data has been preserved.'); }
  }
  return <details className={styles.gallery} onToggle={event => { if (event.currentTarget.open) refresh(); }}>
    <summary>Local agent templates</summary>
    <p>Saved in this browser on this device. Applying fills the title and task for review before launch. Avoid saving secrets.</p>
    <Input label="Template name" maxLength={100} value={name} onChange={event => setName(event.target.value)} disabled={disabled || !loaded} />
    <Button type="button" size="sm" disabled={disabled || !loaded || !name.trim() || !prompt.trim()} onClick={save}>Save current task as template</Button>
    {error && <p role="alert">{error}</p>}
    <p role="status">{notice}</p>
    {loaded && items.length === 0 && <p>No local templates yet. Write a task, then save it here.</p>}
    <ul className={styles.list}>{items.map(item => <li key={item.id}>
      <strong>{item.name}</strong><p className={styles.preview}>{item.prompt}</p>
      <Button type="button" size="sm" disabled={disabled} aria-label={`Apply ${item.name}`} onClick={() => { onApply({ ...item }); setNotice(`${item.name} applied. Review the task before launch.`); }}>Apply</Button>{' '}
      <Button type="button" size="sm" disabled={disabled} aria-label={`Delete ${item.name}`} onClick={() => remove(item.id)}>Delete</Button>
    </li>)}</ul>
  </details>;
}
