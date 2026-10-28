/**
 * First Phantom metrics dashboard: one self-contained HTML file (no network,
 * no scripts), one primary number (value per 1M tokens) and one primary action.
 */
import type { Rollup, ArmStats } from './scoring.js';
import type { StewardReport } from '../steward/disk.js';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmt = (n: number | null, d = 2) => (n === null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: d }));

function bars(points: { label: string; v: number }[], w = 640, h = 140): string {
  if (!points.length) return '<p class="muted">No data yet.</p>';
  const max = Math.max(...points.map((p) => p.v), 1e-9); const bw = w / points.length;
  return `<svg viewBox="0 0 ${w} ${h + 18}" role="img">${points.map((p, i) => { const bh = (p.v / max) * h; return `<rect x="${i * bw + 2}" y="${h - bh}" width="${Math.max(1, bw - 4)}" height="${bh}" rx="2"><title>${esc(p.label)}: ${fmt(p.v)}</title></rect>`; }).join('')}<text x="0" y="${h + 14}">${esc(points[0]!.label)}</text><text x="${w}" y="${h + 14}" text-anchor="end">${esc(points.at(-1)!.label)}</text></svg>`;
}
function board(title: string, rows: ArmStats[]): string {
  return `<section><h2>${esc(title)}</h2><table><tr><th></th><th>Value / 1M tok</th><th>Value / hr</th><th>Value / $</th><th>PRs</th><th>Quality</th></tr>${rows.slice(0, 8).map((r) => `<tr><td>${esc(r.key)}</td><td>${fmt(r.valuePerMTok)}</td><td>${fmt(r.valuePerHour)}</td><td>${fmt(r.valuePerUsd)}</td><td>${r.prsShipped}</td><td>${fmt(r.avgQuality, 3)}</td></tr>`).join('')}</table></section>`;
}

export function renderDashboard(r: Rollup, steward?: StewardReport, generatedAt = new Date().toISOString()): string {
  const t = r.totals;
  const disk = steward ? steward.roots.filter((x) => x.exists).map((x) => `<tr><td>${esc(x.id)}</td><td>${fmt(x.bytes / 1048576, 0)} MB</td><td>${fmt(x.quotaBytes / 1048576, 0)} MB</td><td>${x.overQuota ? '<b class="warn">over</b>' : 'ok'}</td></tr>`).join('') : '';
  const over = steward?.roots.some((x) => x.overQuota);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phantom metrics</title>
<style>body{font:14px/1.5 system-ui,sans-serif;background:#0b0b10;color:#e8e8ef;max-width:960px;margin:32px auto;padding:0 20px}h1{font-size:15px;color:#9a9ab0;font-weight:500}.hero{font-size:56px;font-weight:700;letter-spacing:-1px}.muted{color:#8a8aa0}section{margin:28px 0}h2{font-size:15px}table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border-bottom:1px solid #22222c;text-align:right}td:first-child,th:first-child{text-align:left}svg{width:100%}rect{fill:#7c5cff}text{fill:#8a8aa0;font-size:11px}.warn{color:#ff8a5c}.cta{display:inline-block;margin-top:12px;padding:10px 16px;border-radius:8px;background:#7c5cff;color:#fff;text-decoration:none;font-family:ui-monospace,monospace}.kpis{display:flex;gap:28px;color:#b8b8cc}</style>
<h1>Phantom · value-weighted PRs shipped</h1>
<div class="hero">${fmt(t.valuePerMTok)}<span class="muted" style="font-size:18px"> value / 1M tokens</span></div>
<div class="kpis"><span>${t.prsShipped} PRs shipped</span><span>${fmt(t.valuePerHour)} value/hr</span><span>${fmt(t.valuePerUsd)} value/$</span><span>${fmt(t.tokens, 0)} tokens</span><span>$${fmt(t.costUsd)}</span></div>
${over ? '<code class="cta">phm steward disk --apply</code>' : '<code class="cta">phm improve propose</code>'}
<section><h2>Value shipped per day</h2>${bars(r.byDay.map((d) => ({ label: d.day, v: d.value })))}</section>
<section><h2>Quality trend</h2>${bars(r.prs.map((p) => ({ label: `${p.repo}#${p.number}`, v: p.quality })))}</section>
${board('By agent', r.byAgent)}${board('By strategy', r.byStrategy)}${board('By model', r.byModel)}
<section><h2>Cost per day</h2>${bars(r.byDay.map((d) => ({ label: d.day, v: d.costUsd })))}</section>
${disk ? `<section><h2>Context &amp; disk health</h2><table><tr><th>Root</th><th>Used</th><th>Quota</th><th></th></tr>${disk}</table></section>` : ''}
<p class="muted">Local only · generated ${esc(generatedAt)} · telemetry never leaves this machine unless you opt in.</p></html>`;
}
